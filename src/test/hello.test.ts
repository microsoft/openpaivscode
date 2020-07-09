import * as assert from 'assert';

import { Hello } from '../pai/hello';

/**
 * Test hello
 */
suite('Test Hello', () => {
    test('Say Hello', async () => {
        const hello: Hello = new Hello('kitty');
        const res: string = hello.say();
        assert.equal(res, 'Hello kitty');
    });
});
