/**
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License in the project root for license information.
 *  @author Microsoft
 */
import * as assert from 'assert';
import * as path from 'path';

import { bindExtensionContext } from '../common/singleton';
import { UtilClass } from '../common/util';
import { ClusterManager } from '../pai/clusterManager';

async function asyncAssertThrows(fn: (...args: any[]) => Promise<any>, message: string): Promise<void> {
    try {
        await fn();
        assert.fail(message);
    } catch { }
}

async function asyncAssertDoesNotThrow(fn: (...args: any[]) => Promise<any>, message: string): Promise<void> {
    try {
        await fn();
    } catch (err) {
        console.log(`ERROR: ${err.message}`);
        assert.fail(message);
    }
}

suite('PAI Cluster Configurations', () => {
    test('Configuration Validation', async () => {
        bindExtensionContext(<any>{
            extensionPath: path.resolve(__dirname, '../../'),
            subscriptions: []
        });
        // tslint:disable-next-line: no-unused-expression
        new UtilClass();
        let clusterManager: ClusterManager;
        clusterManager = new ClusterManager();
        clusterManager.configuration = {
            version: '0.0.1',
            pais: [<any>{}]
        };
        await asyncAssertThrows(
            async () => {
                await clusterManager.validateConfiguration();
            },
            'Invalid configuration should not pass validation'
        );
        clusterManager.allConfigurations[0] = <any>null;
        await asyncAssertThrows(
            async () => {
                await clusterManager.validateConfiguration();
            },
            'Null configuration should not pass validation'
        );
        clusterManager.allConfigurations[0] = {
            username: 'openpai',
            password: 'Passq1w2e3r4',
            rest_server_uri: 'openpai.vscode.test:9186',
            webhdfs_uri: 'openpai.vscode.test:50070/webhdfs/v1',
            grafana_uri: 'openpai.vscode.test:3000',
            k8s_dashboard_uri: 'openpai.vscode.test:9090'
        };
        await asyncAssertDoesNotThrow(
            async () => {
                await clusterManager.validateConfiguration();
            },
            'Valid configuration should not trigger error'
        );
    });
});
