/**
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License in the project root for license information.
 * @author Microsoft
 */

import { PAIV2 } from '@microsoft/openpai-js-sdk';
import { TreeItemCollapsibleState } from 'vscode';

import {
    CONTEXT_STORAGE_TEAM_ITEM, ICON_STORAGE
} from '../../../common/constants';
import { __ } from '../../../common/i18n';
import { Util } from '../../../common/util';
import { IPAICluster } from '../../utility/paiInterface';
import { StorageTreeNode } from '../common/treeNode';

import { MountPointTreeNode } from './storageSubItems/mountPointTreeItem';

/**
 * PAI storage mount point tree node.
 */
export class TeamStorageTreeNode extends StorageTreeNode {
    public readonly contextValue: string = CONTEXT_STORAGE_TEAM_ITEM;

    private storageName: string;
    private storageDetail?: PAIV2.IStorageDetail;
    private client: PAIV2.OpenPAIClient;
    private cluster: IPAICluster;

    constructor(
        storageName: string,
        cluster: IPAICluster,
        client: PAIV2.OpenPAIClient,
        parent?: StorageTreeNode,
        collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.Collapsed
    ) {
        super(storageName, parent, collapsibleState);
        this.storageName = storageName;
        this.client = client;
        this.cluster = cluster;
        this.iconPath = Util.resolvePath(ICON_STORAGE);
    }

    public async getStorageDetail(): Promise<void> {
        try {
            if (this.storageDetail) {
                this.children = [
                    new MountPointTreeNode(this.storageDetail, this.cluster, this)
                ];
            } else {
                this.children = [
                    new StorageTreeNode('Empty', this)
                ];
            }
        } catch (e) {
            Util.err('treeview.storage.error', [e.message || e]);
        }
    }

    public async refresh(): Promise<void> {
        try {
            this.storageDetail = await this.client.storage.getStorage(this.storageName);
            await this.getStorageDetail();
        } catch (e) {
            Util.err('treeview.storage.error', [e.message || e]);
        }
    }
}
