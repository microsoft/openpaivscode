/**
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License in the project root for license information.
 * @author Microsoft
 */

import { PAIV2 } from '@microsoft/openpai-js-sdk';
import { TreeItemCollapsibleState, Uri } from 'vscode';

import {
    CONTEXT_STORAGE_PERSONAL_ITEM,
    CONTEXT_STORAGE_PERSONAL_ROOT,
    ICON_STORAGE
} from '../../../common/constants';
import { __ } from '../../../common/i18n';
import { getSingleton } from '../../../common/singleton';
import { Util } from '../../../common/util';
import { PersonalStorageManager } from '../../storage/personalStorageManager';
import { StorageTreeNode } from '../common/treeNode';

import { AzureBlobRootItem } from './storageSubItems/azureBlobTreeItem';
import { NfsRootNode } from './storageSubItems/NfsTreeItem';
import { SambaRootNode } from './storageSubItems/sambaTreeItem';

/**
 * PAI personal storage tree node.
 */
export class PersonalStorageTreeNode extends StorageTreeNode {
    public readonly contextValue: string = CONTEXT_STORAGE_PERSONAL_ITEM;
    public data: StorageTreeNode;
    public index: number;

    constructor(
        storage: PAIV2.IStorageDetail,
        index: number,
        parent?: StorageTreeNode,
        collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.Collapsed
    ) {
        super(storage.name, parent, collapsibleState);
        this.iconPath = Util.resolvePath(ICON_STORAGE);
        this.index = index;
        this.data = this.initializeData(storage);
    }

    public async refresh(): Promise<void> {
        return this.data.refresh();
    }

    public async getChildren(): Promise<StorageTreeNode[]> {
        return this.data.getChildren();
    }

    public async loadMore(): Promise<void> {
        await this.data.loadMore();
    }

    public async uploadFile(files?: Uri[]): Promise<void> {
        await this.data.uploadFile(files);
    }

    public async uploadFolder(): Promise<void> {
        await this.data.uploadFolder();
    }

    public async createFolder(folder?: string): Promise<void> {
        await this.data.createFolder(folder);
    }

    private initializeData(storageDetail: PAIV2.IStorageDetail): StorageTreeNode {
        try {
            switch (storageDetail.type) {
                case 'azureBlob':
                    return new AzureBlobRootItem(storageDetail, '', this);
                case 'azureFile':
                    return new StorageTreeNode('Azure File');
                case 'nfs':
                    return new NfsRootNode(storageDetail, this);
                case 'samba':
                    return new SambaRootNode(storageDetail, this);
                default:
                    return new StorageTreeNode('Unsupported storage');
            }
        } catch (err) {
            return new StorageTreeNode(err.message);
        }
    }
}

/**
 * PAI personal storage root node.
 */
export class PersonalStorageRootNode extends StorageTreeNode {
    public readonly contextValue: string = CONTEXT_STORAGE_PERSONAL_ROOT;

    constructor() {
        super(__('treeview.storage.personal-root.label'), undefined, TreeItemCollapsibleState.Expanded);
    }

    public async refresh(): Promise<void> {
        const personalStorageManager: PersonalStorageManager = await getSingleton(PersonalStorageManager);
        const storages: PAIV2.IStorageDetail[] = personalStorageManager.allConfigurations;

        this.children = storages.map((storage, index) => new PersonalStorageTreeNode(storage, index, this));
    }
}
