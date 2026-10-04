import joplin from 'api';
import { ContentScriptType } from 'api/types';
import { logger } from './logger';

joplin.plugins
    .register({
        onStart: async function () {
            await joplin.contentScripts.register(
                ContentScriptType.CodeMirrorPlugin,
                'wrappedLineIndent',
                './contentScript/cm6IndentPlugin.js'
            );
        },
    })
    .catch((error: unknown) => {
        logger.error('Failed to register plugin', error);
    });
