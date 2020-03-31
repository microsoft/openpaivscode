// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as fs from 'fs-extra';
import { injectable } from 'inversify';
import * as yaml from 'js-yaml';
import { OpenPAIClient } from 'openpai-js-sdk';
import { IJobStatus } from 'openpai-js-sdk/lib/models/job';
import * as os from 'os';
import * as path from 'path';
import * as uuid from 'uuid';
import {
    commands,
    extensions,
    window,
    workspace,
    StatusBarAlignment,
    StatusBarItem,
    Terminal,
    TextEditor,
    Uri,
    WorkspaceConfiguration,
    WorkspaceFolder
} from 'vscode';

import {
    COMMAND_CREATE_REMOTE_JOB,
    OCTICON_CLOUDUPLOAD,
    REMOTE_SSH_EXTENSION_ID,
    SETTING_JOB_GENERATEJOBNAME_ENABLED,
    SETTING_JOB_V2_UPLOAD
} from '../common/constants';
import { __ } from '../common/i18n';
import { delay, getSingleton, Singleton } from '../common/singleton';
import { IKeyPair, Util } from '../common/util';

import { ClusterManager } from './clusterManager';
import { ClusterExplorerChildNode } from './container/configurationTreeDataProvider';
import { IJobParam, PAIJobManager } from './paiJobManager';
import { StorageHelper } from './storage/storageHelper';
import {
    IPAICluster,
    IPAIJobConfigV2,
    IPAIJobV2UploadConfig
} from './utility/paiInterface';

/**
 * Manager class for PAI remote job
 */
@injectable()
export class RemoteManager extends Singleton {
    private static readonly PUBLIC_KEY_FILE_NAME: string = '.pai_ssh/public.key';
    private static readonly PRIVATE_KEY_FILE_NAME: string = '.pai_ssh/private.key';

    private lastRemoteJobEditorPath: string | undefined;

    public async onActivate(): Promise<void> {
        this.context.subscriptions.push(
            commands.registerCommand(
                COMMAND_CREATE_REMOTE_JOB,
                async (input?: ClusterExplorerChildNode) => {
                    await this.createRemoteJob(input);
                }
            )
        );
    }

    public async activateRemoteSshExtension(): Promise<boolean> {
        const ext: any = extensions.getExtension(REMOTE_SSH_EXTENSION_ID);
        if (!ext) {
            await window.showWarningMessage('Please install \'Remote - SSH\' via the Extensions pane.');
            return false;
        }

        return true;
    }

    public async createRemoteJob(input?: ClusterExplorerChildNode): Promise<void> {
        if (!await this.activateRemoteSshExtension()) {
            return;
        }

        let cluster: IPAICluster;
        if (input instanceof ClusterExplorerChildNode) {
            const clusterManager: ClusterManager = await getSingleton(ClusterManager);
            cluster = clusterManager.allConfigurations[input.index];
        } else {
            cluster = await (await getSingleton(PAIJobManager)).pickCluster();
        }
        const key: IKeyPair = await this.generateRemoteKey();
        const job: IPAIJobConfigV2 = await this.generateRemoteJob(cluster, key);
        const jobName: string | undefined = await this.editRemoteJob(job.name + '.pai.yaml', job, cluster);
        if (jobName) {
            Util.info('job.waiting.running');

            const client: OpenPAIClient = new OpenPAIClient({
                rest_server_uri: cluster.rest_server_uri,
                token: cluster.token,
                username: cluster.username,
                password: cluster.password,
                https: cluster.https
            });

            try {
                let jobStatus: IJobStatus;
                while (true) {
                    jobStatus = <IJobStatus>await client.job.getFrameworkInfo(cluster.username!, jobName);
                    if (jobStatus.jobStatus.state === 'WAITING') {
                        await delay(1000);
                    } else {
                        break;
                    }
                }

                const remote: string = __('job.submission.success.remote');
                const res: string | undefined = await window.showInformationMessage(
                    __('job.submission.success'),
                    remote
                );

                if (res === remote) {
                    await this.remoteJob(jobStatus);
                }
            } catch (ex) {
                console.log(ex);
            }
        }
    }

    public async remoteJob(jobStatus: IJobStatus): Promise<void> {
        const remoteSettings: WorkspaceConfiguration = workspace.getConfiguration('remote');
        let configPath: string;
        if (remoteSettings.get('SSH.configFile')) {
            configPath = remoteSettings.get<string>('SSH.configFile')!;
        } else {
            configPath = path.join(this.currentWorkspace(), 'config');
            if (!fs.existsSync(path.dirname(configPath))) {
                fs.mkdirSync(path.dirname(configPath));
            }

            if (!fs.existsSync(configPath)) {
                fs.createFileSync(configPath);
            }

            await remoteSettings.update('SSH.configFile', configPath);
        }
        const privateKeyPath: string = path.join(os.homedir(), RemoteManager.PRIVATE_KEY_FILE_NAME);

        Object.entries(jobStatus.taskRoles).forEach(([key, value]: [string, any]) => {
            for (const taskStatus of <any[]>value.taskStatuses) {
                const jobSshConfig: string = `Host ${jobStatus.name}_${key}_${taskStatus.taskIndex}\n` +
                    `  HostName ${taskStatus.containerIp}\n` +
                    `  IdentityFile "${privateKeyPath}"\n` +
                    `  Port ${taskStatus.containerPorts.ssh}\n` +
                    '  User root\n';
                fs.appendFileSync(configPath, jobSshConfig);
            }
        });

        try {
            await commands.executeCommand('opensshremotesexplorer.emptyWindowInNewWindow');
        } catch (ex) {
            console.log(ex);
            await commands.executeCommand('workbench.view.remote');
        }
    }

    public async generateRemoteJob(cluster: IPAICluster, key: IKeyPair): Promise<IPAIJobConfigV2> {
        const jobName: string = this.generateRemoteJobName(cluster);

        // SSH Plugin
        const runtimeplugin: any[] = [{
            plugin: 'ssh',
            parameters: {
                jobssh: true,
                userssh: {
                    type: 'custom',
                    value: key.public
                }
            }
        }];

        // Storage Plugin
        try {
            const storages: string[] = await StorageHelper.getStorages(cluster);
            runtimeplugin.push({
                plugin: 'teamwise_storage',
                parameters: {
                    storageConfigNames: storages
                }
            });
        } catch (ex) {
            console.log(ex);
        }

        return <IPAIJobConfigV2>{
            protocolVersion: 2,
            name: jobName,
            type: 'job',
            prerequisites: [
                {
                    name: 'image',
                    type: 'dockerimage',
                    uri: 'openpai/tensorflow-py36-cu90'
                }
            ],
            taskRoles: {
                taskrole: {
                    instances: 1,
                    dockerImage: 'image',
                    resourcePerInstance: {
                      cpu: 1,
                      memoryMB: 8192,
                      gpu: 1
                    },
                    commands: ['sleep 5h']
                }
            },
            extras: {
                'com.microsoft.pai.runtimeplugin': runtimeplugin
            }
        };
    }

    public async generateRemoteKey(): Promise<IKeyPair> {
        const privateKeyPath: string = path.join(os.homedir(), RemoteManager.PRIVATE_KEY_FILE_NAME);
        const publicKeyPath: string = path.join(os.homedir(), RemoteManager.PUBLIC_KEY_FILE_NAME);

        try {
            if (!fs.existsSync(privateKeyPath) || !fs.existsSync(publicKeyPath)) {
                Util.info('job.remote.generate.ssh.key');

                const keyPair: IKeyPair = Util.generateSSHKeyPair();

                if (!fs.existsSync(path.dirname(privateKeyPath))) {
                    fs.mkdirSync(path.dirname(privateKeyPath));
                }

                if (!fs.existsSync(path.dirname(publicKeyPath))) {
                    fs.mkdirSync(path.dirname(publicKeyPath));
                }

                await fs.writeFile(privateKeyPath, keyPair.private);
                await fs.writeFile(publicKeyPath, keyPair.public);

                const terminal: Terminal = window.createTerminal('PAI Secure SSH private key');
                terminal.sendText(`cmd /c Icacls "${privateKeyPath}" /c /t /Inheritance:d`);
                terminal.sendText(`cmd /c Icacls "${privateKeyPath}" /c /t /Grant %UserName%:F`);
                terminal.sendText(
                    `cmd /c Icacls "${privateKeyPath}"  /c /t /Remove Administrator BUILTIN\\Administrators BUILTIN Everyone System Users`
                );
                terminal.sendText(`cmd /c Icacls "${privateKeyPath}"`);

                return keyPair;
            } else {
                return <IKeyPair> {
                    private: fs.readFileSync(privateKeyPath, 'utf8'),
                    public: fs.readFileSync(publicKeyPath, 'utf8')
                };
            }
        } catch (ex) {
            console.log(ex);
            throw ex;
        }
    }

    private async editRemoteJob(fileName: string, job: IPAIJobConfigV2, cluster?: IPAICluster): Promise<string | undefined> {
        const tempPath: string = await Util.getNewTempDirectory();
        const filePath: string = path.join(tempPath, fileName.replace(/\//g, ''));

        if (window.activeTextEditor &&
            window.activeTextEditor.document.fileName === this.lastRemoteJobEditorPath) {
            await window.activeTextEditor.document.save();
            if (window.activeTextEditor &&
                window.activeTextEditor.document.fileName === this.lastRemoteJobEditorPath) {
                await commands.executeCommand('workbench.action.closeActiveEditor');
            }
            void window.showWarningMessage(__('remote.edit.job.previousexpired'));
        }

        await fs.writeFile(filePath, yaml.safeDump(job));
        const editor: TextEditor = await window.showTextDocument(Uri.file(filePath));
        let resultJobName: string | undefined;

        // DO NOT use filePath - there may be difference with drive letters ('C' vs 'c')
        this.lastRemoteJobEditorPath = editor.document.fileName;

        try {
            while (true) {
                const SUBMIT: string = __('common.submit');
                const CANCEL: string = __('common.cancel');
                // Only error message won't be collapsed automatically by vscode.
                const result: string | undefined = await window.showErrorMessage(
                    __('job.remote.edit.prompt'),
                    SUBMIT,
                    CANCEL
                );
                if (result === SUBMIT) {
                    await editor.document.save();
                    const statusBarItem: StatusBarItem = window.createStatusBarItem(StatusBarAlignment.Right, Number.MAX_VALUE);
                    statusBarItem.text = `${OCTICON_CLOUDUPLOAD} ${__('job.prepare.status')}`;
                    statusBarItem.show();

                    try {
                        const jobConfig: IPAIJobConfigV2 = yaml.safeLoad(editor.document.getText());
                        const jobManager: PAIJobManager = await getSingleton(PAIJobManager);
                        if (!cluster) {
                            cluster = await jobManager.pickCluster();
                        }
                        const settings: WorkspaceConfiguration = await jobManager.ensureSettingsV2(cluster);
                        const generateJobName: boolean | undefined = settings.get(SETTING_JOB_GENERATEJOBNAME_ENABLED);
                        const param: IJobParam = {
                            config: jobConfig,
                            jobVersion: 2,
                            cluster: cluster,
                            workspace: this.currentWorkspace(),
                            generateJobName: generateJobName ? generateJobName : false
                        };
                        const uploadConfig: IPAIJobV2UploadConfig | undefined = settings.get(SETTING_JOB_V2_UPLOAD);
                        if (uploadConfig && uploadConfig[cluster.name!] && uploadConfig[cluster.name!].enable) {
                            param.upload = uploadConfig[cluster.name!];
                        }

                        resultJobName = await jobManager.submitJobV2(param, statusBarItem);
                    } catch (e) {
                        Util.err('job.submission.error', [e.message || e]);
                    } finally {
                        statusBarItem.dispose();
                    }
                }
                break;
            }
        } finally {
            // Try to close the temporary editor - vscode doesn't provide close editor API so do it hacky way
            // Note: The editor may have already been closed, either by user or by another editJSON session.
            if (window.activeTextEditor === editor) {
                await editor.document.save();

                // Check again in case the editor is not the original one
                if (window.activeTextEditor === editor) {
                    await commands.executeCommand('workbench.action.closeActiveEditor');
                }
            }
            await Util.cleanTempDirectory(tempPath);
        }

        return resultJobName;
    }

    private generateRemoteJobName(cluster: IPAICluster): string {
        return `${cluster.username}_remote_${uuid().substring(0, 8)}`;
    }

    private currentWorkspace(): string {
        const folders: WorkspaceFolder[] | undefined = workspace.workspaceFolders;
        const folder: WorkspaceFolder | undefined =
            folders && folders.length > 0 ? folders[0] : undefined;
        if (!folder) {
            throw new Error(__('common.workspace.nofolder'));
        }
        return folder.uri.fsPath;
    }
}
