/**
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License in the project root for license information.
 *  @author Microsoft
 */

import * as assert from 'assert';
import { ISuiteCallbackContext } from 'mocha';
import { back as nockBack } from 'nock';
import { join } from 'path';
import { FileType, Uri } from 'vscode';

import { bindExtensionContext } from '../common/singleton';
import { UtilClass } from '../common/util';
import { ClusterManager } from '../pai/clusterManager';
import { HDFSFileSystemProvider } from '../pai/storage/hdfs';

// /out/test/../../src/test/fixures
nockBack.fixtures = join(__dirname, '../../src/test', 'fixtures');
nockBack.setMode('record');

function mockUri(path: string): Uri {
    return Uri.parse('webhdfs://openpai@openpai.vscode.test' + path);
}

suite('HDFS Client', function (this: ISuiteCallbackContext): void {
    this.timeout(0);
    let testClusterManager: ClusterManager;

    suiteSetup(async () => {
        bindExtensionContext(<any>{
            subscriptions: []
        });
        testClusterManager = new ClusterManager();
        testClusterManager.configuration = {
            version: '0.0.1',
            pais: [{
                name: 'Sample Cluster',
                username: 'openpai',
                rest_server_uri: 'openpai.vscode.test/rest-server',
                webhdfs_uri: 'openpai.vscode.test/webhdfs/api/v1',
                grafana_uri: 'openpai.vscode.test/grafana',
                k8s_dashboard_uri: 'openpai.vscode.test/kubernetes-dashboard',
                web_portal_uri: 'openpai.vscode.test/'
            }]
        };
        // tslint:disable-next-line: no-unused-expression
        new UtilClass();
    });

    test('File CRUD', async () => {
        const hdfsProvider: HDFSFileSystemProvider = new HDFSFileSystemProvider(
            () => <any>testClusterManager
        );
        const { nockDone } = await nockBack('hdfs.filecrud.json');

        await hdfsProvider.writeFile(mockUri('/testfile'), new Buffer('fa'), { create: true, overwrite: false });
        assert.deepEqual(
            (await hdfsProvider.readDirectory(mockUri('/'))).find(file => file[0] === 'testfile'),
            ['testfile', FileType.File],
            'Cannot find created file when listing directory'
        );
        assert.equal(
            (await hdfsProvider.readFile(mockUri('/testfile'))).toString(),
            'fa',
            'File content is different from original'
        );
        await hdfsProvider.delete(mockUri('/testfile'), { recursive: false });
        assert.equal(
            (await hdfsProvider.readDirectory(mockUri('/'))).find(file => file[0] === 'testfile'),
            undefined,
            'Deleted file is still found when listing directory'
        );

        nockDone();
    });

    test('Folder CRUD', async () => {
        const hdfsProvider: HDFSFileSystemProvider = new HDFSFileSystemProvider(
            () => <any>testClusterManager
        );
        const { nockDone } = await nockBack('hdfs.foldercrud.json');
        await hdfsProvider.createDirectory(mockUri('/testfolder'));
        assert.deepEqual(
            (await hdfsProvider.readDirectory(mockUri('/'))).find(file => file[0] === 'testfolder'),
            ['testfolder', FileType.Directory],
            'Cannot find created directory when listing directory'
        );
        await hdfsProvider.writeFile(mockUri('/testfolder/testfile'), new Buffer('fa'), { create: true, overwrite: false });
        assert.deepEqual(
            (await hdfsProvider.readDirectory(mockUri('/testfolder'))).find(file => file[0] === 'testfile'),
            ['testfile', FileType.File],
            'Cannot find created file when listing directory'
        );
        assert.equal(
            (await hdfsProvider.readFile(mockUri('/testfolder/testfile'))).toString(),
            'fa',
            'File content is different from original'
        );
        await hdfsProvider.copy(mockUri('/testfolder/testfile'), mockUri('/testfile'), { overwrite: false });
        assert.equal(
            (await hdfsProvider.readFile(mockUri('/testfile'))).toString(),
            'fa',
            'Copied file content is different from original'
        );
        await hdfsProvider.delete(mockUri('/testfolder'), { recursive: true });
        assert.equal(
            (await hdfsProvider.readDirectory(mockUri('/'))).find(file => file[0] === 'testfolder'),
            undefined,
            'Deleted folder is still found when listing directory'
        );
        await hdfsProvider.delete(mockUri('/testfile'), { recursive: false });
        assert.equal(
            (await hdfsProvider.readDirectory(mockUri('/'))).find(file => file[0] === 'testfile'),
            undefined,
            'Deleted file is still found when listing directory'
        );

        nockDone();
    });
});
