import joplin from 'api';
import { ContentScriptType } from 'api/types';

joplin.plugins.register({
    onStart: async function () {
        await joplin.contentScripts.register(
            ContentScriptType.CodeMirrorPlugin,
            'wrappedLineIndent',
            './contentScript/cm6IndentPlugin.js'
        );
    },
});
