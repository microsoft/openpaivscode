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
import { commands, window, workspace, WorkspaceFolder } from 'vscode';

import { COMMAND_CREATE_REMOTE_JOB } from '../common/constants';
import { __ } from '../common/i18n';
import { Singleton } from '../common/singleton';
import { Util } from '../common/util';

import { ClusterExplorerChildNode } from './container/configurationTreeDataProvider';
import {
    IPAICluster,
    IPAIJobConfigV2,
    IPAIJobV2UploadConfig,
    IPAITaskRole,
    IUploadConfig
} from './utility/paiInterface';

/**
 * Manager class for PAI remote job
 */
@injectable()
export class PAIJobManager extends Singleton {
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

    }

    public async generateRemoteJob(): Promise<IPAIJobConfigV2> {

    }

    public async generateRemoteKey(): Promise<void> {
        const folders: WorkspaceFolder[] | undefined = workspace.workspaceFolders;
        const folder: WorkspaceFolder | undefined =
            folders && folders.length > 0 ? folders[0] : undefined;
        if (!folder) {
            throw new Error(__('common.workspace.nofolder'));
        }
        const path: string = folder.uri.fsPath;


    }

    private async editRemoteJob(fileName: string): Promise<string> {
        const tempPath: string = await Util.getNewTempDirectory();
        let filePath: string = path.join(tempPath, fileName.replace(/\//g, ''));

        if (window.activeTextEditor &&
            window.activeTextEditor.document.fileName === this.lastRemoteJobEditorPath) {
            await window.activeTextEditor.document.save();
            if (window.activeTextEditor &&
                window.activeTextEditor.document.fileName === this.lastRemoteJobEditorPath) {
                await commands.executeCommand('workbench.action.closeActiveEditor');
            }
            void window.showWarningMessage(__('remote.edit.job.previousexpired'));
        }


    }
}
