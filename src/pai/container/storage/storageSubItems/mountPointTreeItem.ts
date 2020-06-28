/**
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License in the project root for license information.
 * @author Microsoft
 */

import { PAIV2 } from '@microsoft/openpai-js-sdk';
import { TreeItemCollapsibleState, Uri } from 'vscode';

import {
    CONTEXT_STORAGE_MOUNTPOINT_ITEM
} from '../../../../common/constants';
import { __ } from '../../../../common/i18n';
import { IPAICluster } from '../../../utility/paiInterface';
import { StorageTreeNode } from '../../common/treeNode';

import { AzureBlobRootItem } from './azureBlobTreeItem';
import { NfsRootNode } from './NfsTreeItem';
import { SambaRootNode } from './sambaTreeItem';

/**
 * PAI storage mount point tree node.
 */
export class MountPointTreeNode extends StorageTreeNode {
    public contextValue: string = CONTEXT_STORAGE_MOUNTPOINT_ITEM;
    public data: StorageTreeNode;
    public cluster: IPAICluster;

    constructor(
        storage: PAIV2.IStorageDetail,
        cluster: IPAICluster,
        parent?: StorageTreeNode,
        collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.Collapsed
    ) {
        super('Mount Point', parent, collapsibleState);
        this.description = this.getMountPointPath(storage);

        this.cluster = cluster;
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

    private getMountPointPath(storageDetail: PAIV2.IStorageDetail): string {
        return `/mnt/${storageDetail.name}`;
    }
}
