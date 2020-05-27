
/**
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License in the project root for license information.
 * @author Microsoft
 */

import { PAIV2 } from '@microsoft/openpai-js-sdk';
import * as fs from 'fs-extra';
import * as path from 'path';
import { TreeItemCollapsibleState, Uri } from 'vscode';

import {
    CONTEXT_STORAGE_SAMBA} from '../../../../common/constants';
import { __ } from '../../../../common/i18n';
import { PathBaseStorageManager } from '../../../storage/pathBaseStorageManager';
import { StorageTreeNode } from '../../common/treeNode';

import { PathBaseTreeNode } from './pathBaseTreeItem';

/**
 * PAI Samba storage root node.
 */
export class SambaRootNode extends StorageTreeNode {
    public storage: PAIV2.IStorageDetail;
    public rootPath: string;

    constructor(storage: PAIV2.IStorageDetail, parent: StorageTreeNode) {
        super(storage.name, parent, TreeItemCollapsibleState.Collapsed);
        this.contextValue = CONTEXT_STORAGE_SAMBA;
        this.storage = storage;
        this.description = 'Samba';
        this.rootPath = `//${(<any>storage.data).address}`;
    }

    public async refresh(): Promise<void> {
        try {
            const list: string[] = fs.readdirSync(this.rootPath);
            this.children = list.map(name =>
                new PathBaseTreeNode(name, path.join(this.rootPath, name), this));
        } catch (err) {
            const child: StorageTreeNode =
                new StorageTreeNode(__('treeview.node.storage.load-error'), this.parent);
            child.description = err.message;
            this.children.push(child);
        }
    }

    public async uploadFile(files?: Uri[]): Promise<void> {
        await PathBaseStorageManager.uploadFiles(this, files);
    }

    public async uploadFolder(): Promise<void> {
        await PathBaseStorageManager.uploadFolders(this);
    }

    public async createFolder(folder?: string): Promise<void> {
        await PathBaseStorageManager.createFolder(this, folder);
    }
}
