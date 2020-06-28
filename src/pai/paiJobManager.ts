/**
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License in the project root for license information.
 * @author Microsoft
 */

import { PAIV1 } from '@microsoft/openpai-js-sdk';
import * as fs from 'fs-extra';
import * as globby from 'globby';
import { injectable } from 'inversify';
import * as yaml from 'js-yaml';
import * as JSONC from 'jsonc-parser';
import { isEmpty, isNil, range } from 'lodash';
import opn = require('opn'); // tslint:disable-line
import * as os from 'os';
import * as path from 'path';
import * as request from 'request-promise-native';
import unixify = require('unixify'); // tslint:disable-line
import * as uuid from 'uuid';
import * as vscode from 'vscode';

import {
    COMMAND_CREATE_JOB_CONFIG,
    COMMAND_CREATE_JOB_CONFIG_V1,
    COMMAND_CREATE_JOB_CONFIG_V2,
    COMMAND_SIMULATE_JOB,
    COMMAND_SUBMIT_JOB,
    OCTICON_CLOUDUPLOAD,
    SCHEMA_JOB_CONFIG,
    SCHEMA_YAML_JOB_CONFIG,
    SETTING_JOB_GENERATEJOBNAME_ENABLED,
    SETTING_JOB_UPLOAD_ENABLED,
    SETTING_JOB_UPLOAD_EXCLUDE,
    SETTING_JOB_UPLOAD_INCLUDE,
    SETTING_JOB_V2_UPLOAD,
    SETTING_SECTION_JOB
} from '../common/constants';
import { __ } from '../common/i18n';
import { getSingleton, Singleton } from '../common/singleton';
import { Util } from '../common/util';

import { getClusterIdentifier, ClusterManager } from './clusterManager';
import { ClusterExplorerChildNode } from './container/configurationTreeDataProvider';
import { RecentJobManager } from './recentJobManager';
import { getHDFSUriAuthority, HDFS, HDFSFileSystemProvider } from './storage/hdfs';
import { StorageHelper } from './storage/storageHelper';
import { IPAICluster, IPAIJobConfigV1, IPAIJobConfigV2, IPAIJobV2UploadConfig, IPAITaskRole, IUploadConfig } from './utility/paiInterface';
import { PAIRestUri, PAIWebPortalUri } from './utility/paiUri';
import { registerYamlSchemaSupport } from './yaml/yamlSchemaSupport';

export interface ITokenItem {
    token: string;
    expireTime: number;
}

export interface IJobParam {
    config: IPAIJobConfigV1 | IPAIJobConfigV2;
    jobVersion: number;
    cluster?: IPAICluster;
    workspace: string;
    upload?: {
        exclude: string[];
        include: string[];
    } | IUploadConfig;
    generateJobName: boolean;
}

export interface IJobInput {
    jobConfigPath?: string;
    clusterIndex?: number;
}

/**
 * Manager class for PAI job submission
 */
@injectable()
export class PAIJobManager extends Singleton {
    private static readonly TIMEOUT: number = 60 * 1000;
    private static readonly SIMULATION_DOCKERFILE_FOLDER: string = '.pai_simulator';
    private static readonly propertiesToBeReplaced: (keyof IPAIJobConfigV1)[] = [
        'codeDir',
        'outputDir',
        'dataDir',
        'authFile'
    ];
    private static readonly envNeedClusterInfo: string[] = [
        'PAI_USER_NAME',
        'PAI_CODE_DIR',
        'PAI_OUTPUT_DIR',
        'PAI_DATA_DIR',
        'PAI_DEFAULT_FS_URI'
    ];
    private cachedTokens: Map<string, ITokenItem> = new Map();
    private simulateTerminal: vscode.Terminal | undefined;

    constructor() {
        super();
        this.context.subscriptions.push(
            vscode.commands.registerCommand(
                COMMAND_CREATE_JOB_CONFIG,
                async (input?: ClusterExplorerChildNode | vscode.Uri) => {
                    await this.generateJobConfig(input);
                }
            ),
            vscode.commands.registerCommand(
                COMMAND_CREATE_JOB_CONFIG_V1,
                async (input: vscode.Uri) => {
                    await this.generateJobConfigV1(input.fsPath);
                }
            ),
            vscode.commands.registerCommand(
                COMMAND_CREATE_JOB_CONFIG_V2,
                async (input: vscode.Uri) => {
                    await this.generateJobConfigV2(input.fsPath);
                }
            ),
            vscode.commands.registerCommand(
                COMMAND_SIMULATE_JOB,
                async (input?: ClusterExplorerChildNode | vscode.Uri) => {
                    if (input instanceof vscode.Uri) {
                        await this.simulate({ jobConfigPath: input.fsPath });
                    } else if (input instanceof ClusterExplorerChildNode) {
                        await this.simulate({ clusterIndex: input.index });
                    } else {
                        await this.simulate();
                    }
                }
            ),
            vscode.commands.registerCommand(
                COMMAND_SUBMIT_JOB,
                async (input?: ClusterExplorerChildNode | vscode.Uri) => {
                    if (input instanceof vscode.Uri) {
                        await this.submitJob({ jobConfigPath: input.fsPath });
                    } else if (input instanceof ClusterExplorerChildNode) {
                        await this.submitJob({ clusterIndex: input.index });
                    } else {
                        await this.submitJob();
                    }
                }
            )
        );
    }

    private static async ensureGenerateJobNameSetting(): Promise<vscode.WorkspaceConfiguration> {
        const settings: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(SETTING_SECTION_JOB);
        if (settings.get(SETTING_JOB_GENERATEJOBNAME_ENABLED) === null) {
            const YES: vscode.QuickPickItem = {
                label: __('common.yes'),
                description: __('job.prepare.generate-job-name.yes.detail')
            };
            const NO: vscode.QuickPickItem = {
                label: __('common.no')
            };
            const item: vscode.QuickPickItem | undefined = await Util.pick(
                [YES, NO],
                __('job.prepare.generate-job-name.prompt')
            );
            if (item === YES) {
                await settings.update(SETTING_JOB_GENERATEJOBNAME_ENABLED, true);
            } else if (item === NO) {
                await settings.update(SETTING_JOB_GENERATEJOBNAME_ENABLED, false);
            } else {
                Util.info('job.prepare.generate-job-name.undefined.hint');
            }
        }
        // reload settings
        return vscode.workspace.getConfiguration(SETTING_SECTION_JOB);
    }

    private static async ensureSettingsV1(): Promise<vscode.WorkspaceConfiguration> {
        const settings: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(SETTING_SECTION_JOB);
        if (settings.get(SETTING_JOB_UPLOAD_ENABLED) === null) {
            const YES: vscode.QuickPickItem = {
                label: __('common.yes'),
                description: __('job.prepare.upload.yes.detail')
            };
            const NO: vscode.QuickPickItem = {
                label: __('common.no')
            };
            const item: vscode.QuickPickItem | undefined = await Util.pick(
                [YES, NO],
                __('job.prepare.upload.prompt')
            );
            if (item === YES) {
                await settings.update(SETTING_JOB_UPLOAD_ENABLED, true);
                await settings.update(SETTING_JOB_UPLOAD_EXCLUDE, []);
                await settings.update(SETTING_JOB_UPLOAD_INCLUDE, ['**/*.py']);
            } else if (item === NO) {
                await settings.update(SETTING_JOB_UPLOAD_ENABLED, false);
            } else {
                await settings.update(SETTING_JOB_UPLOAD_ENABLED, true);
                await settings.update(SETTING_JOB_UPLOAD_EXCLUDE, []);
                await settings.update(SETTING_JOB_UPLOAD_INCLUDE, ['**/*.py']);
                Util.info('job.prepare.upload.undefined.hint');
            }
        }
        return await this.ensureGenerateJobNameSetting();
    }

    private static replaceVariables(jobParam: IJobParam): IPAIJobConfigV1 {
        // Replace environment variable
        const config: IPAIJobConfigV1 = <IPAIJobConfigV1>jobParam.config;
        const cluster: IPAICluster | undefined = jobParam.cluster;
        function replaceVariable(x: string): string {
            return x.replace('$PAI_JOB_NAME', config.jobName)
                .replace('$PAI_USER_NAME', cluster!.username!);
        }
        for (const key of PAIJobManager.propertiesToBeReplaced) {
            const old: string | IPAITaskRole[] | undefined = config[key];
            if (typeof old === 'string') {
                config[key] = replaceVariable(old);
            }
        }
        if (config.taskRoles) {
            for (const role of config.taskRoles) {
                role.command = replaceVariable(role.command);
            }
        }
        return config;
    }

    public async ensureSettingsV2(cluster?: IPAICluster): Promise<vscode.WorkspaceConfiguration> {
        const settings: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(SETTING_SECTION_JOB);
        if (!settings.get(SETTING_JOB_V2_UPLOAD)) {
            const YES: vscode.QuickPickItem = {
                label: __('common.yes'),
                description: __('job.prepare.upload.yes.detail')
            };
            const NO: vscode.QuickPickItem = {
                label: __('common.no')
            };
            const item: vscode.QuickPickItem | undefined = await Util.pick(
                [YES, NO],
                __('job.prepare.upload.prompt')
            );
            if (!cluster) {
                cluster = await this.pickCluster();
            }
            if (item === YES) {
                let uploadConfig: IPAIJobV2UploadConfig = {};
                uploadConfig = await this.pickUploadStorage(cluster, uploadConfig);
                await settings.update(SETTING_JOB_V2_UPLOAD, uploadConfig);
            }
        } else {
            let uploadConfig: any = settings.get(SETTING_JOB_V2_UPLOAD)!;
            if (!cluster) {
                cluster = await this.pickCluster();
            }
            if (!uploadConfig[cluster.name!]) {
                const YES: vscode.QuickPickItem = {
                    label: __('common.yes'),
                    description: __('job.prepare.upload.yes.detail')
                };
                const NO: vscode.QuickPickItem = {
                    label: __('common.no')
                };
                const item: vscode.QuickPickItem | undefined = await Util.pick(
                    [YES, NO],
                    __('job.prepare.upload.prompt')
                );
                if (item === YES) {
                    uploadConfig = await this.pickUploadStorage(cluster, uploadConfig);
                    await settings.update(SETTING_JOB_V2_UPLOAD, uploadConfig);
                }
            }
        }
        return await PAIJobManager.ensureGenerateJobNameSetting();
    }

    public async generateJobConfig(input?: ClusterExplorerChildNode | vscode.Uri): Promise<void> {
        if (input instanceof ClusterExplorerChildNode) {
            const clusterManager: ClusterManager = await getSingleton(ClusterManager);
            const cluster: IPAICluster = clusterManager.allConfigurations[input.index];

            if (cluster.protocol_version === '2') {
                await this.generateJobConfigV2();
            } else {
                await this.generateJobConfigV1();
            }
        } else if (input instanceof vscode.Uri) {
            await this.generateJobConfigV2(input.fsPath);
        } else {
            await this.generateJobConfigV2();
        }
    }

    public async generateJobConfigV1(script?: string): Promise<void> {
        let defaultSaveDir: string;
        let config: IPAIJobConfigV1 | undefined;
        if (!script) {
            const folders: vscode.WorkspaceFolder[] | undefined = vscode.workspace.workspaceFolders;
            let parent: string = os.homedir();
            const name: string = 'new_job';
            if (!isEmpty(folders)) {
                const fileFolders: vscode.WorkspaceFolder[] = folders!.filter(x => x.uri.scheme === 'file');
                if (!isEmpty(fileFolders)) {
                    parent = fileFolders[0].uri.fsPath;
                }
            }
            defaultSaveDir = path.join(parent, `${name}.pai.jsonc`);
            config = {
                jobName: '<job name>',
                image: 'aiplatform/pai.build.base',
                codeDir: '$PAI_DEFAULT_FS_URI/$PAI_USER_NAME/$PAI_JOB_NAME',
                dataDir: '$PAI_DEFAULT_FS_URI/Data/$PAI_JOB_NAME',
                outputDir: '$PAI_DEFAULT_FS_URI/Output/$PAI_JOB_NAME',
                taskRoles: [
                    {
                        name: 'task',
                        taskNumber: 1,
                        cpuNumber: 1,
                        gpuNumber: 0,
                        memoryMB: 1000,
                        command: 'python $PAI_JOB_NAME/<start up script>'
                    }
                ]
            };
        } else {
            const workspace: vscode.WorkspaceFolder | undefined = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(script));
            let parent: string;
            if (workspace === undefined) {
                parent = path.dirname(script);
            } else {
                parent = workspace.uri.fsPath;
            }
            script = path.relative(parent, script);
            const jobName: string = path.basename(script, path.extname(script));
            defaultSaveDir = path.join(parent, `${jobName}.pai.jsonc`);
            config = {
                jobName,
                image: 'aiplatform/pai.build.base',
                codeDir: '$PAI_DEFAULT_FS_URI/$PAI_USER_NAME/$PAI_JOB_NAME',
                dataDir: '$PAI_DEFAULT_FS_URI/Data/$PAI_JOB_NAME',
                outputDir: '$PAI_DEFAULT_FS_URI/Output/$PAI_JOB_NAME',
                taskRoles: [
                    {
                        name: 'task',
                        taskNumber: 1,
                        cpuNumber: 1,
                        gpuNumber: 0,
                        memoryMB: 1000,
                        command: `python $PAI_JOB_NAME/${unixify(script)}`
                    }
                ]
            };
        }

        const saveDir: vscode.Uri | undefined = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(defaultSaveDir),
            filters: {
                JSON: ['json', 'jsonc']
            }
        });
        if (saveDir) {
            if (saveDir.fsPath.endsWith('.jsonc')) {
                await fs.writeFile(saveDir.fsPath, await Util.generateCommentedJSON(config, 'pai_job_config.schema.json'));
            } else {
                await fs.writeJSON(saveDir.fsPath, config, { spaces: 4 });
            }
            await vscode.window.showTextDocument(saveDir);
        }
    }

    /**
     * Generate a YAML job config file.
     * @param script the file path.
     */
    public async generateJobConfigV2(script?: string): Promise<void> {
        const cluster: IPAICluster = await this.pickCluster();
        const settings: vscode.WorkspaceConfiguration = await this.ensureSettingsV2(cluster);
        let parent: string;
        if (script) {
            const workspace: any = script ?
                vscode.workspace.getWorkspaceFolder(vscode.Uri.file(script)) :
                vscode.workspace.workspaceFolders;
            if (workspace === undefined) {
                parent = path.dirname(script);
            } else {
                parent = workspace.uri.fsPath;
            }
            script = path.relative(parent, script);
        } else {
            parent = os.homedir();
            const folders: vscode.WorkspaceFolder[] | undefined = vscode.workspace.workspaceFolders;
            if (!isEmpty(folders)) {
                const fileFolders: vscode.WorkspaceFolder[] = folders!.filter(x => x.uri.scheme === 'file');
                if (!isEmpty(fileFolders)) {
                    parent = fileFolders[0].uri.fsPath;
                }
            }
        }

        const jobName: string = script ? path.basename(script, path.extname(script)) : 'new_job';
        const defaultSaveDir: string = path.join(parent, `${jobName}.pai.yaml`);

        const runtimeplugin: any[] = [{
            plugin: 'ssh',
            parameters: {
                jobssh: true
            }
        }];

        let sourceCodePath: string = '$PAI_JOB_NAME';
        const commands: string[] = [];
        const uploadConfig: IPAIJobV2UploadConfig | undefined = settings.get(SETTING_JOB_V2_UPLOAD);
        if (uploadConfig && uploadConfig[cluster.name!] && uploadConfig[cluster.name!].enable) {
            const upload: IUploadConfig = uploadConfig[cluster!.name!];
            commands.push(`export PAI_AUTO_UPLOAD_DIR="${upload.storageMountPoint}"`);
            sourceCodePath = '$PAI_AUTO_UPLOAD_DIR/$PAI_JOB_NAME';

            runtimeplugin.push({
                plugin: 'teamwise_storage',
                parameters: {
                    storageConfigNames: [upload.storageName]
                }
            });
        }

        if (script) {
            commands.push(`python ${sourceCodePath}/${unixify(script)}`);
        } else {
            commands.push('python <start up script>');
        }

        const config: IPAIJobConfigV2 = {
            protocolVersion: 2,
            name: jobName,
            type: 'job',
            prerequisites: [
                {
                    name: 'image',
                    type: 'dockerimage',
                    uri: 'aiplatform/pai.build.base'
                }
            ],
            taskRoles: {
                train: {
                    instances: 1,
                    dockerImage: 'image',
                    resourcePerInstance: {
                      cpu: 1,
                      memoryMB: 16384,
                      gpu: 1
                    },
                    commands: commands
                }
            },
            extras: {
                'com.microsoft.pai.runtimeplugin': runtimeplugin
            }
        };

        const saveDir: vscode.Uri | undefined = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(defaultSaveDir),
            filters: {
                YAML: ['yml', 'yaml']
            }
        });

        if (saveDir) {
            await fs.writeFile(saveDir.fsPath, yaml.safeDump(config));
            await vscode.window.showTextDocument(saveDir);
        }
    }

    // tslint:disable-next-line
    public async submitJob(input: IJobInput = {}): Promise<void> {
        const statusBarItem: vscode.StatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, Number.MAX_VALUE);
        statusBarItem.text = `${OCTICON_CLOUDUPLOAD} ${__('job.prepare.status')}`;
        statusBarItem.show();

        try {
            const param: IJobParam | undefined = await this.prepareJobParam(input);
            if (!param) {
                // Error message has been shown.
                return;
            }
            if (!param.cluster) {
                param.cluster = await this.pickCluster();
            }

            if (param.jobVersion === 2) {
                await this.submitJobV2(param, statusBarItem);
            } else {
                await this.submitJobV1(param, statusBarItem);
            }
        } catch (e) {
            Util.err('job.submission.error', [e.message || e]);
        } finally {
            statusBarItem.dispose();
        }
    }

    public async onActivate(): Promise<void> {
        await registerYamlSchemaSupport();
    }

    private async submitJobV1(param: IJobParam, statusBarItem: vscode.StatusBarItem): Promise<void> {
        const config: IPAIJobConfigV1 = <IPAIJobConfigV1>param.config;
        const cluster: IPAICluster = <IPAICluster>param.cluster!;

        // add job name suffix
        if (param.generateJobName) {
            config.jobName = `${config.jobName}_${uuid().substring(0, 8)}`;
        } else {
            try {
                await request.get(PAIRestUri.jobDetail(cluster, cluster.username!, config.jobName), {
                    headers: { Authorization: `Bearer ${await this.getToken(cluster)}` },
                    timeout: PAIJobManager.TIMEOUT,
                    json: true
                });
                // job exists
                const ENABLE_GENERATE_SUFFIX: string = __('job.submission.name-exist.enable');
                const CANCEL: string = __('common.cancel');
                const res: string | undefined = await vscode.window.showErrorMessage(
                    __('job.submission.name-exist'),
                    ENABLE_GENERATE_SUFFIX,
                    CANCEL
                );
                if (res === ENABLE_GENERATE_SUFFIX) {
                    await vscode.workspace.getConfiguration(SETTING_SECTION_JOB).update(SETTING_JOB_GENERATEJOBNAME_ENABLED, true);
                    config.jobName = `${config.jobName}_${uuid().substring(0, 8)}`;
                } else {
                    // cancel
                    return;
                }
            } catch (e) {
                if (e.response.body.code === 'NoJobError') {
                    // pass
                } else {
                    throw new Error(e.status ? `${e.status}: ${e.response.body.message}` : e);
                }
            }
        }

        // replace env variables
        PAIJobManager.replaceVariables(param);

        // auto upload
        statusBarItem.text = `${OCTICON_CLOUDUPLOAD} ${__('job.upload.status')}`;
        if (param.upload) {
            if (!await this.uploadCode(param)) {
                return;
            }
        }

        // send job submission request
        statusBarItem.text = `${OCTICON_CLOUDUPLOAD} ${__('job.request.status')}`;
        try {
            await request.post(PAIRestUri.jobs(cluster, cluster.username), {
                headers: { Authorization: `Bearer ${await this.getToken(cluster)}` },
                form: param.config,
                timeout: PAIJobManager.TIMEOUT,
                json: true
            });
            void (await getSingleton(RecentJobManager)).enqueueRecentJobs(cluster, config.jobName);
            const open: string = __('job.submission.success.open');
            void vscode.window.showInformationMessage(
                __('job.submission.success'),
                open
            ).then(async res => {
                const url: string = await PAIWebPortalUri.jobDetail(param.cluster!, param.cluster!.username!, config.jobName);
                if (res === open) {
                    await Util.openExternally(url);
                }
            });
        } catch (e) {
            throw new Error(e.status ? `${e.status}: ${e.response.body.message}` : e);
        }
    }

    // tslint:disable-next-line:member-ordering
    public async submitJobV2(param: IJobParam, statusBarItem: vscode.StatusBarItem): Promise<string | undefined> {
        const config: IPAIJobConfigV2 = <IPAIJobConfigV2>param.config;
        const cluster: IPAICluster = param.cluster!;

        // add job name suffix
        if (param.generateJobName) {
            config.name = `${config.name}_${uuid().substring(0, 8)}`;
        } else {
            try {
                await request.get(PAIRestUri.jobDetail(cluster, cluster.username!, config.name), {
                    headers: { Authorization: `Bearer ${await this.getToken(cluster)}` },
                    timeout: PAIJobManager.TIMEOUT,
                    json: true
                });
                // job exists
                const ENABLE_GENERATE_SUFFIX: string = __('job.submission.name-exist.enable');
                const CANCEL: string = __('common.cancel');
                const res: string | undefined = await vscode.window.showErrorMessage(
                    __('job.submission.name-exist'),
                    ENABLE_GENERATE_SUFFIX,
                    CANCEL
                );
                if (res === ENABLE_GENERATE_SUFFIX) {
                    await vscode.workspace.getConfiguration(SETTING_SECTION_JOB).update(SETTING_JOB_GENERATEJOBNAME_ENABLED, true);
                    config.name = `${config.name}_${uuid().substring(0, 8)}`;
                } else {
                    // cancel
                    return;
                }
            } catch (e) {
                if (e.response.body.code === 'NoJobError') {
                    // pass
                } else {
                    throw new Error(e.status ? `${e.status}: ${e.response.body.message}` : e);
                }
            }
        }

        // auto upload
        statusBarItem.text = `${OCTICON_CLOUDUPLOAD} ${__('job.upload.status')}`;
        if (param.upload) {
            if (!await this.uploadCodeV2(param)) {
                return;
            }
        }

        statusBarItem.text = `${OCTICON_CLOUDUPLOAD} ${__('job.request.status')}`;
        try {
            await request.post(
                PAIRestUri.jobsV2(cluster),
                {
                    headers: {
                        Authorization: `Bearer ${await this.getToken(cluster)}`,
                        'Content-Type': 'text/yaml'
                    },
                    body: yaml.safeDump(config),
                    timeout: PAIJobManager.TIMEOUT
                });
            void (await getSingleton(RecentJobManager)).enqueueRecentJobs(cluster, config.name);
            const open: string = __('job.submission.success.open');
            void vscode.window.showInformationMessage(
                __('job.submission.success'),
                open
            ).then(async res => {
                const url: string = await PAIWebPortalUri.jobDetail(cluster, cluster.username!, config.name);
                if (res === open) {
                    await Util.openExternally(url);
                }
            });
        } catch (e) {
            throw new Error(e.status ? `${e.status}: ${e.response.body.message}` : e);
        }

        return config.name;
    }

    // tslint:disable-next-line
    public async simulate(input: IJobInput = {}): Promise<void> {
        const statusBarItem: vscode.StatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, Number.MAX_VALUE);
        statusBarItem.text = `${OCTICON_CLOUDUPLOAD} ${__('job.simulation.status')}`;
        statusBarItem.show();

        try {
            await this.prepareJobConfigPath(input);
            const param: IJobParam | undefined = await this.prepareJobParam(input);
            if (!param) {
                // Error message has been shown.
                return;
            }
            if (param.jobVersion === 2) {
                await this.simulateV2(param);
            } else {
                await this.simulateV1(param);
            }
        } catch (e) {
            Util.err('job.simulation.error', [e.message || e]);
        } finally {
            statusBarItem.dispose();
        }
    }

    // tslint:disable-next-line
    public async simulateV1(param: IJobParam): Promise<void> {
        const config: IPAIJobConfigV1 = <IPAIJobConfigV1>param.config;
        if (!param.cluster) {
            let pickCluster: boolean = false;
            // pick cluster if auto upload is disabled.
            if (!param.upload) {
                pickCluster = true;
            }
            if (PAIJobManager.envNeedClusterInfo.some(
                x => config.codeDir.includes(`$${x}`) || config.taskRoles.some(
                    y => y.command.includes(`$${x}`)
                )
            )) {
                pickCluster = true;
            }

            if (pickCluster) {
                param.cluster = await this.pickCluster();
            }
        }

        // replace env variables if auto upload is disabled
        // extension will try to download files from hdfs instead of copying local files
        if (!param.upload) {
            PAIJobManager.replaceVariables(param);
        }

        // generate dockerfile
        const dockerfileDir: string = path.join(param.workspace, PAIJobManager.SIMULATION_DOCKERFILE_FOLDER);
        const jobDir: string = path.join(dockerfileDir, config.jobName);
        await fs.remove(jobDir);
        await fs.ensureDir(jobDir);
        let scriptName: string;
        if (os.platform() === 'win32') {
            scriptName = 'run-docker.cmd';
        } else {
            scriptName = 'run-docker.sh';
        }
        for (const role of config.taskRoles) {
            // 0. init
            const taskDir: string = path.join(jobDir, role.name);
            await fs.ensureDir(taskDir);
            const dockerfile: string[] = [];
            // 1. comments
            dockerfile.push('# Generated by OpenPAI VS Code Client');
            dockerfile.push(`# Job Name: ${config.jobName}`);
            dockerfile.push(`# Task Name: ${role.name}`);
            dockerfile.push('');
            // 2. from
            dockerfile.push(`FROM ${config.image}`);
            dockerfile.push('');
            // 3. source code
            const codeDir: string = path.join(taskDir, config.jobName);
            await fs.ensureDir(codeDir);
            if (param.upload) {
                // copy from local
                const projectFiles: string[] = await globby(param.upload.include, {
                    cwd: param.workspace,
                    onlyFiles: true,
                    absolute: true,
                    ignore: param.upload.exclude || []
                });
                await Promise.all(projectFiles.map(async file => {
                    await fs.copy(file, path.join(codeDir, path.relative(param.workspace, file)));
                }));
            } else {
                // copy from remote
                const fsProvider: HDFSFileSystemProvider = (await getSingleton(HDFS)).provider!;
                let remoteCodeDir: string = config.codeDir;
                if (remoteCodeDir.startsWith('$PAI_DEFAULT_FS_URI')) {
                    remoteCodeDir = remoteCodeDir.substring('$PAI_DEFAULT_FS_URI'.length);
                }
                const remoteCodeUri: vscode.Uri = vscode.Uri.parse(`webhdfs://${getHDFSUriAuthority(param.cluster!)}${remoteCodeDir}`);
                await fsProvider.copy(remoteCodeUri, vscode.Uri.file(codeDir), { overwrite: true });
            }
            dockerfile.push('WORKDIR /pai');
            dockerfile.push(`COPY ${config.jobName} /pai/${config.jobName}`);
            dockerfile.push('');
            // 4. env var
            dockerfile.push('ENV PAI_WORK_DIR /pai');
            dockerfile.push(`ENV PAI_JOB_NAME ${config.jobName}`);
            if (param.cluster) {
                dockerfile.push(`ENV PAI_DEFAULT_FS_URI ${param.cluster.hdfs_uri}`);
                dockerfile.push(`ENV PAI_USER_NAME ${param.cluster.username}`);
                dockerfile.push(`ENV PAI_DATA_DIR ${config.dataDir}`);
                dockerfile.push(`ENV PAI_CODE_DIR ${config.codeDir}`);
                dockerfile.push(`ENV PAI_OUTPUT_DIR ${config.outputDir}`);
            }
            dockerfile.push('');
            // check unsupported env variables
            const supportedEnvList: string[] = [
                'PAI_WORK_DIR',
                'PAI_JOB_NAME',
                'PAI_DEFAULT_FS_URI',
                'PAI_USER_NAME',
                'PAI_DATA_DIR',
                'PAI_CODE_DIR',
                'PAI_OUTPUT_DIR'
            ];
            let command: string = role.command;
            for (const env of supportedEnvList) {
                command = command.replace(new RegExp(`\\$${env}`, 'g'), '');
            }
            if (command.includes('$PAI')) {
                Util.warn('job.simulation.unsupported-env-var', role.command);
            }
            // 5. entrypoint
            dockerfile.push(`ENTRYPOINT ["/bin/bash", "-c", "${role.command.replace(/"/g, '\\"')}}"]`);
            dockerfile.push('');
            // 6. write dockerfile
            await fs.writeFile(path.join(taskDir, 'dockerfile'), dockerfile.join('\n'));
            // EX. write shell script
            const imageName: string = `pai-simulator-${config.jobName}-${role.name}`;
            await fs.writeFile(
                path.join(taskDir, scriptName),
                [
                    `docker build -t ${imageName} ${Util.quote(taskDir)}`,
                    `docker run --rm ${imageName}`,
                    `docker rmi ${imageName}`,
                    os.platform() === 'win32' ? 'pause' : 'read -p "Press [Enter] to continue ..."'
                ].join('\n')
            );
        }

        const reveal: string = __('job.simulation.success-dialog.reveal');
        const runFirstTask: string = __('job.simulation.success-dialog.run-first-task');
        await vscode.window.showInformationMessage(
            __('job.simulation.success', [PAIJobManager.SIMULATION_DOCKERFILE_FOLDER, config.jobName, scriptName]),
            runFirstTask,
            reveal
        ).then((res) => {
            if (res === reveal) {
                void opn(jobDir);
            } else if (res === runFirstTask) {
                if (!this.simulateTerminal || !vscode.window.terminals.find(x => x.processId === this.simulateTerminal!.processId)) {
                    this.simulateTerminal = vscode.window.createTerminal('pai-simulator');
                }
                this.simulateTerminal.show(true);
                if (os.platform() === 'win32') {
                    this.simulateTerminal.sendText(`cmd /c "${path.join(jobDir, config.taskRoles[0].name, scriptName)}"`);
                } else {
                    this.simulateTerminal.sendText(`bash '${path.join(jobDir, config.taskRoles[0].name, scriptName)}'`);
                }
            }
        });
    }

    // tslint:disable-next-line
    public async simulateV2(param: IJobParam): Promise<void> {
        const config: IPAIJobConfigV2 = <IPAIJobConfigV2>param.config;
        // generate dockerfile
        const dockerfileDir: string = path.join(param.workspace, PAIJobManager.SIMULATION_DOCKERFILE_FOLDER);
        const jobDir: string = path.join(dockerfileDir, config.name);
        await fs.remove(jobDir);
        await fs.ensureDir(jobDir);
        let scriptName: string;
        if (os.platform() === 'win32') {
            scriptName = 'run-docker.cmd';
        } else {
            scriptName = 'run-docker.sh';
        }
        for (const [name, role] of Object.entries(config.taskRoles)) {
            // 0. init
            const taskDir: string = path.join(jobDir, name);
            await fs.ensureDir(taskDir);
            const dockerfile: string[] = [];
            // 1. comments
            dockerfile.push('# Generated by OpenPAI VS Code Client');
            dockerfile.push(`# Job Name: ${config.name}`);
            dockerfile.push(`# Task Name: ${name}`);
            dockerfile.push('');
            // 2. from
            let image: any;
            for (const prerequisite of config.prerequisites!) {
                if (prerequisite.type === 'dockerimage' && prerequisite.name === role.dockerImage) {
                    image = prerequisite;
                }
            }
            dockerfile.push(`FROM ${image.uri}`);
            dockerfile.push('');
            // 3. source code
            const codeDir: string = path.join(taskDir, config.name);
            await fs.ensureDir(codeDir);
            if (param.upload) {
                // copy from local
                const projectFiles: string[] = await globby(param.upload.include, {
                    cwd: param.workspace,
                    onlyFiles: true,
                    absolute: true,
                    ignore: param.upload.exclude || []
                });
                await Promise.all(projectFiles.map(async file => {
                    await fs.copy(file, path.join(codeDir, path.relative(param.workspace, file)));
                }));
            }
            dockerfile.push('WORKDIR /pai');
            if (param.upload) {
                const upload: IUploadConfig = <IUploadConfig>param.upload;
                if (upload.enable) {
                    dockerfile.push(`COPY ${config.name} /${upload.storageMountPoint}/${config.name}`);
                }
            } else {
                dockerfile.push(`COPY ${config.name} /pai/${config.name}`);
            }
            dockerfile.push('');
            // 4. env var
            dockerfile.push('ENV PAI_WORK_DIR /pai');
            dockerfile.push(`ENV PAI_JOB_NAME ${config.name}`);
            if (param.cluster) {
                dockerfile.push(`ENV PAI_DEFAULT_FS_URI ${param.cluster.hdfs_uri}`);
                dockerfile.push(`ENV PAI_USER_NAME ${param.cluster.username}`);
            }
            // check unsupported env variables
            const supportedEnvList: string[] = [
                'PAI_JOB_NAME',
                'PAI_USER_NAME',
                'PAI_DEFAULT_FS_URI',
                'PAI_TASK_ROLE_COUNT',
                'PAI_TASK_ROLE_LIST',
                'PAI_TASK_ROLE_TASK_COUNT_*',
                'PAI_HOST_IP_*_*',
                'PAI_PORT_LIST_*_*_*',
                'PAI_RESOURCE_*',
                'PAI_MIN_FAILED_TASK_COUNT_*',
                'PAI_MIN_SUCCEEDED_TASK_COUNT_*',
                'PAI_CURRENT_TASK_ROLE_NAME',
                'PAI_CURRENT_TASK_ROLE_CURRENT_TASK_INDEX',
                'PAI_AUTO_UPLOAD_DIR'
            ];
            const command: string = role.commands.join(' && ').replace(new RegExp(supportedEnvList.join('|'), 'g'), '');
            if (command.includes('$PAI')) {
                Util.warn('job.simulation.unsupported-env-var', role.commands);
            }
            dockerfile.push('');
            // 5. entrypoint
            dockerfile.push(`ENTRYPOINT ["/bin/bash", "-c", "${role.commands.join(' && ').replace(/"/g, '\\"')}"]`);
            dockerfile.push('');
            // 6. write dockerfile
            await fs.writeFile(path.join(taskDir, 'dockerfile'), dockerfile.join('\n'));
            // EX. write shell script
            const imageName: string = `pai-simulator-${config.name}-${name}`;
            await fs.writeFile(
                path.join(taskDir, scriptName),
                [
                    `docker build -t ${imageName} ${Util.quote(taskDir)}`,
                    `docker run --rm ${imageName}`,
                    `docker rmi ${imageName}`,
                    os.platform() === 'win32' ? 'pause' : 'read -p "Press [Enter] to continue ..."'
                ].join('\n')
            );
        }

        const reveal: string = __('job.simulation.success-dialog.reveal');
        const runFirstTask: string = __('job.simulation.success-dialog.run-first-task');
        await vscode.window.showInformationMessage(
            __('job.simulation.success', [PAIJobManager.SIMULATION_DOCKERFILE_FOLDER, config.name, scriptName]),
            runFirstTask,
            reveal
        ).then((res) => {
            if (res === reveal) {
                void opn(jobDir);
            } else if (res === runFirstTask) {
                if (!this.simulateTerminal || !vscode.window.terminals.find(x => x.processId === this.simulateTerminal!.processId)) {
                    this.simulateTerminal = vscode.window.createTerminal('pai-simulator');
                }
                this.simulateTerminal.show(true);
                if (os.platform() === 'win32') {
                    this.simulateTerminal.sendText(`cmd /c "${path.join(jobDir, Object.keys(config.taskRoles)[0], scriptName)}"`);
                } else {
                    this.simulateTerminal.sendText(`bash '${path.join(jobDir, Object.keys(config.taskRoles)[0], scriptName)}'`);
                }
            }
        });
    }

    // tslint:disable-next-line
    public async pickCluster(): Promise<IPAICluster> {
        const clusterManager: ClusterManager = await getSingleton(ClusterManager);
        const pickResult: number | undefined = await clusterManager.pick();
        if (pickResult === undefined) {
            throw new Error(__('job.prepare.cluster.cancelled'));
        }
        return clusterManager.allConfigurations[pickResult];
    }

    private async pickUploadStorage(cluster: IPAICluster, config: IPAIJobV2UploadConfig): Promise<IPAIJobV2UploadConfig> {
        const mountPoints: {
            storage: string;
            mountPoint: string;
        }[] = await StorageHelper.getStorageMountPoints(cluster);

        let pickPersonalStorage: boolean = true;

        if (mountPoints.length > 0) {
            const CLUSTER: vscode.QuickPickItem = {
                label: __('common.cluster.storage')
            };
            const PERSONAL: vscode.QuickPickItem = {
                label: __('common.personal.storage')
            };
            const item: vscode.QuickPickItem | undefined = await Util.pick(
                [CLUSTER, PERSONAL],
                __('job.prepare.upload.storage.type')
            );

            if (item !== PERSONAL) {
                const pickStorage: number | undefined =
                    await Util.pick(range(mountPoints.length), __('storage.upload.pick.prompt'), (index: number) => {
                        const str: string = mountPoints[index].storage + ':' + mountPoints[index].mountPoint;
                        return {label: str};
                    });
                if (pickStorage !== undefined) {
                    config[cluster.name!] = {
                        enable: true,
                        include: ['**/*.py'],
                        exclude: [],
                        storageType: 'cluster',
                        storageName: mountPoints[pickStorage].storage,
                        storageMountPoint: mountPoints[pickStorage].mountPoint
                    };
                } else {
                    config[cluster.name!] = {
                        enable: false,
                        include: ['**/*.py'],
                        exclude: []
                    };
                }
                pickPersonalStorage = false;
            }
        }

        if (pickPersonalStorage) {
            const personalStorages: string[] = await StorageHelper.getPersonalStorages();
            const pickStorage: number | undefined =
                await Util.pick(range(personalStorages.length), __('storage.upload.pick.prompt'), (index: number) => {
                    const str: string = personalStorages[index];
                    return {label: str};
                });
            if (pickStorage !== undefined) {
                config[cluster.name!] = {
                    enable: true,
                    include: ['**/*.py'],
                    exclude: [],
                    storageType: 'personal',
                    storageName: personalStorages[pickStorage]
                };
            } else {
                config[cluster.name!] = {
                    enable: false,
                    include: ['**/*.py'],
                    exclude: []
                };
            }
        }

        return config;
    }

    private async prepareJobConfigPath(jobInput: IJobInput): Promise<void> {
        if (!jobInput.jobConfigPath) {
            Util.info('job.prepare.config.prompt');
            const folders: vscode.WorkspaceFolder[] |  undefined = vscode.workspace.workspaceFolders;
            const jobConfigUrl: vscode.Uri[] | undefined = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectMany: false,
                defaultUri: !isEmpty(folders) ? folders![0].uri : undefined
            });
            if (isEmpty(jobConfigUrl)) {
                Util.err('job.prepare.cluster.cancelled');
                return;
            }
            jobInput.jobConfigPath = jobConfigUrl![0].fsPath;
        }
    }

    private async prepareJobParam(jobInput: IJobInput): Promise<IJobParam | undefined> {
        const result: Partial<IJobParam> = {};
        // 1. job config
        await this.prepareJobConfigPath(jobInput);
        const jobConfigPath: string | undefined = jobInput.jobConfigPath;
        const clusterIndex: number | undefined = jobInput.clusterIndex;
        const jobVersion: number = (jobConfigPath!.toLowerCase().endsWith('yaml') || jobConfigPath!.toLowerCase().endsWith('yml')) ? 2 : 1;
        result.jobVersion = jobVersion;
        let config: IPAIJobConfigV1 | IPAIJobConfigV2;

        let error: string | undefined;
        config = jobVersion === 2 ?
            yaml.safeLoad(await fs.readFile(jobConfigPath!, 'utf8')) : JSONC.parse(await fs.readFile(jobConfigPath!, 'utf8'));
        if (isNil(config)) {
            Util.err('job.prepare.config.invalid');
        }
        error = jobVersion === 2 ?
            await Util.validateJSON(config, SCHEMA_YAML_JOB_CONFIG) : await Util.validateJSON(config, SCHEMA_JOB_CONFIG);
        if (error) {
            throw new Error(error);
        }
        result.config = config;

        // 2. workspace
        const workspace: vscode.WorkspaceFolder | undefined = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(jobConfigPath!));
        if (!workspace) {
            throw new Error(__('common.workspace.nofolder'));
        }
        result.workspace = workspace.uri.fsPath;

        // 3. cluster
        if (clusterIndex) {
            const clusterManager: ClusterManager = await getSingleton(ClusterManager);
            result.cluster = clusterManager.allConfigurations[clusterIndex];
        } else {
            result.cluster = await this.pickCluster();
        }

        // 4. settings
        const settings: vscode.WorkspaceConfiguration = jobVersion === 1 ?
            await PAIJobManager.ensureSettingsV1() : await this.ensureSettingsV2(result.cluster);
        if (jobVersion === 1 && settings.get(SETTING_JOB_UPLOAD_ENABLED)) {
            result.upload = {
                include: settings.get<string[]>(SETTING_JOB_UPLOAD_INCLUDE)!,
                exclude: settings.get<string[]>(SETTING_JOB_UPLOAD_EXCLUDE)!
            };
        }
        if (jobVersion === 2) {
            const uploadConfig: IPAIJobV2UploadConfig | undefined = settings.get(SETTING_JOB_V2_UPLOAD);
            if (uploadConfig && uploadConfig[result.cluster!.name!] && uploadConfig[result.cluster!.name!].enable) {
                result.upload = uploadConfig[result.cluster!.name!];
            }
        }
        result.generateJobName = settings.get(SETTING_JOB_GENERATEJOBNAME_ENABLED);

        return <IJobParam>result;
    }

    private async getToken(cluster: IPAICluster): Promise<string> {
        if (cluster.token) {
            return cluster.token;
        }

        const id: string = getClusterIdentifier(cluster);
        let item: ITokenItem | undefined = this.cachedTokens.get(id);
        if (!item || Date.now() > item.expireTime) {
            const result: any = await request.post(PAIRestUri.token(cluster), {
                form: {
                    username: cluster.username,
                    password: cluster.password,
                    expiration: 4000
                },
                timeout: PAIJobManager.TIMEOUT,
                json: true
            });
            item = {
                token: result.token,
                expireTime: Date.now() + 3600 * 1000
            };
            this.cachedTokens.set(id, item);
        }

        return item.token;
    }

    private async uploadCode(param: IJobParam): Promise<boolean> {
        const config: PAIV1.IJobConfig = <PAIV1.IJobConfig>param.config;

        if (!param.cluster!.webhdfs_uri) {
            Util.err('pai.webhdfs.missing');
            return false;
        }

        try {
            // Avoid using vscode.workspace.findFiles for now - webhdfs:// folder in workspace will raise exception
            const projectFiles: string[] = await globby(param.upload!.include, {
                cwd: param.workspace, onlyFiles: true, absolute: true,
                ignore: param.upload!.exclude || []
            });
            const fsProvider: HDFSFileSystemProvider = (await getSingleton(HDFS)).provider!;
            let codeDir: string = config.codeDir;
            if (codeDir.startsWith('hdfs://') || codeDir.startsWith('webhdfs://')) {
                throw new Error(__('job.upload.invalid-code-dir'));
            } else {
                if (codeDir.startsWith('$PAI_DEFAULT_FS_URI')) {
                    codeDir = codeDir.substring('$PAI_DEFAULT_FS_URI'.length);
                }
                codeDir = path.posix.resolve('/', codeDir);
            }

            const codeUri: vscode.Uri = vscode.Uri.parse(`webhdfs://${getHDFSUriAuthority(param.cluster!)}${codeDir}`);

            const total: number = projectFiles.length;
            const createdDirectories: Set<string> = new Set([ codeUri.path ]);
            await fsProvider.createDirectory(codeUri);

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: __('job.upload.status')
                },
                async (progress) => {
                    for (const [i, file] of projectFiles.entries()) {
                        const suffix: string = path.relative(param.workspace, file);
                        const baseFolder: string = path.dirname(suffix);
                        if (baseFolder !== '.') {
                            const baseFolderUri: vscode.Uri = Util.uriPathAppend(codeUri, path.dirname(suffix));
                            if (!createdDirectories.has(baseFolderUri.path)) {
                                createdDirectories.add(baseFolderUri.path);
                                await fsProvider.createDirectory(baseFolderUri);
                            }
                        }
                        progress.report({
                            message: __('job.upload.progress', [i + 1, total]),
                            increment: 1 / total * 100
                        });
                        await fsProvider.copy(vscode.Uri.file(file), Util.uriPathAppend(codeUri, suffix), { overwrite: true });
                    }
                }
            );

            return true;
        } catch (e) {
            Util.err('job.upload.error', [e.message]);
            return false;
        }
    }

    private async uploadCodeV2(param: IJobParam): Promise<boolean> {
        const config: IPAIJobConfigV2 = <IPAIJobConfigV2>param.config;
        const uploadConfig: IUploadConfig = <IUploadConfig>param.upload;

        try {
            const projectFiles: string[] = await globby(param.upload!.include, {
                cwd: param.workspace, onlyFiles: true, absolute: true,
                ignore: param.upload!.exclude || []
            });
            const total: number = projectFiles.length;

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: __('job.upload.status')
                },
                async (progress) => {
                    for (const [i, file] of projectFiles.entries()) {
                        progress.report({
                            message: __('job.upload.progress', [i + 1, total]),
                            increment: 1 / total * 100
                        });
                        const suffix: string = path.relative(param.workspace, file);
                        await StorageHelper.uploadFile(
                            uploadConfig,
                            param.cluster!.name!,
                            `${param.cluster!.username!}~${config.name}`,
                            vscode.Uri.file(file),
                            suffix
                        );
                    }
                }
            );

            return true;
        } catch (e) {
            const submitAnyway: string = __('job.submission.submit.anyway');
            const cancelSubmission: string = __('job.submission.submit.cancel');
            const result: string | undefined = await vscode.window.showErrorMessage(
                __('storage.upload.error', [uploadConfig.storageName, e.message]),
                submitAnyway,
                cancelSubmission
            );
            return result === submitAnyway;
        }
    }
}
