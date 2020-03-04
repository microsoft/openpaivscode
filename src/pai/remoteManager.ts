/**
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License in the project root for license information.
 * @author Microsoft
 */

import * as fs from 'fs-extra';
import * as globby from 'globby';
import { injectable } from 'inversify';
import * as yaml from 'js-yaml';
import * as JSONC from 'jsonc-parser';
import { isEmpty, isNil, range } from 'lodash';
import * as os from 'os';
import * as path from 'path';
import * as request from 'request-promise-native';
import * as uuid from 'uuid';
import { commands, window, workspace, WorkspaceFolder, Uri, TextEditor } from 'vscode';

import { COMMAND_CREATE_REMOTE_JOB } from '../common/constants';
import { __ } from '../common/i18n';
import { Singleton, getSingleton } from '../common/singleton';
import { Util, IKeyPair } from '../common/util';

import { ClusterExplorerChildNode } from './container/configurationTreeDataProvider';
import {
    IPAICluster,
    IPAIJobConfigV2,
    IPAIJobV2UploadConfig,
    IPAITaskRole,
    IUploadConfig
} from './utility/paiInterface';
import { PAIJobManager } from './paiJobManager';
import { StorageHelper } from './storage/storageHelper';

/**
 * Manager class for PAI remote job
 */
@injectable()
export class RemoteManager extends Singleton {
    private static readonly TIMEOUT: number = 60 * 1000;
    private static readonly REMOTE_SSH_KEY_FOLDER: string = '.pai_remote';
    private static readonly PUBLIC_KEY_FILE_NAME: string = 'public.key';
    private static readonly PRIVATE_KEY_FILE_NAME: string = 'private.key';

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

    public async createRemoteJob(input?: ClusterExplorerChildNode): Promise<void> {
        const key: IKeyPair = await this.generateRemoteKey();
        const cluster: IPAICluster = await (await getSingleton(PAIJobManager)).pickCluster();
        const job: IPAIJobConfigV2 = await this.generateRemoteJob(cluster, key);
        await this.editRemoteJob(job.name + '.pai.yaml', job);
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
        const storages: string[] = await StorageHelper.getStorages(cluster));
        runtimeplugin.push({
            plugin: 'teamwise_storage',
            parameters: {
                storageConfigNames: storages
            }
        });

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
                train: {
                    instances: 1,
                    dockerImage: 'image',
                    resourcePerInstance: {
                      cpu: 1,
                      memoryMB: 16384,
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
        const folders: WorkspaceFolder[] | undefined = workspace.workspaceFolders;
        const folder: WorkspaceFolder | undefined =
            folders && folders.length > 0 ? folders[0] : undefined;
        if (!folder) {
            throw new Error(__('common.workspace.nofolder'));
        }
        const workspacePath: string = folder.uri.fsPath;
        const privateKeyPath: string = path.join(workspacePath, RemoteManager.PRIVATE_KEY_FILE_NAME);
        const publicKeyPath: string = path.join(workspacePath, RemoteManager.PUBLIC_KEY_FILE_NAME);

        if (!fs.existsSync(privateKeyPath) || !fs.existsSync(publicKeyPath)) {
            Util.info('job.remote.generate.ssh.key');

            const keyPair: IKeyPair = Util.generateSSHKeyPair();
            await fs.writeFile(privateKeyPath, keyPair.private);
            await fs.writeFile(publicKeyPath, keyPair.public);
            return keyPair;
        } else {
            return <IKeyPair> {
                private: fs.readFileSync(privateKeyPath, 'utf8'),
                public: fs.readFileSync(publicKeyPath, 'utf8')
            };
        }
    }

    private async editRemoteJob(fileName: string, job: IPAIJobConfigV2): Promise<string> {
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

        // DO NOT use filePath - there may be difference with drive letters ('C' vs 'c')
        this.lastRemoteJobEditorPath = editor.document.fileName;

        try {
            while (true) {
                const SUBMIT: string = __('common.finish');
                const CANCEL: string = __('common.cancel');
                // Only error message won't be collapsed automatically by vscode.
                const result: string | undefined = await window.showErrorMessage(
                    __('job.remote.edit.prompt'),
                    SUBMIT,
                    CANCEL
                );
                if (result === SUBMIT) {
                    await editor.document.save();
                    try {
                        if (schemaFile) {
                            const error: string | undefined = await this.validateJSON(editedObject, schemaFile);
                            if (error) {
                                this.err('util.editjson.validationerror', [error]);
                                continue;
                            }
                        }
                        return editedObject;
                    } catch (ex) {
                        this.err('util.editjson.parseerror', [ex]);
                        continue;
                    }
                }
                return;
            }
        } finally {
            // Try to close the temporary editor - vscode doesn't provide close editor API so do it hacky way
            // Note: The editor may have already been closed, either by user or by another editJSON session.
            if (vscode.window.activeTextEditor === editor) {
                await editor.document.save();

                // Check again in case the editor is not the original one
                if (vscode.window.activeTextEditor === editor) {
                    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                }
            }
            await this.cleanTempDirectory(tempPath);
        }
    }

    private generateRemoteJobName(cluster: IPAICluster): string {
        return `${cluster.username}_remote_${uuid().substring(0, 8)}`;
    }
}
