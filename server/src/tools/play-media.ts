import { logOut } from '../utils/logger.js';
import { defineTool } from './define-tool.js';
import type { PlayFrame } from '../types/crelay.js';

interface PlayMediaArgs {
    source: string;
    loop?: number;
    preemptible?: boolean;
    interruptible?: boolean;
}

interface PlayMediaResult {
    success: boolean;
    message: string;
    source: string;
    outgoingMessage?: PlayFrame;
    [key: string]: unknown;
}

export const playMediaTool = defineTool<PlayMediaArgs, PlayMediaResult>({
    name: 'play-media',
    description: 'Plays an audio file from a URL during the call',
    parameters: {
        type: 'object',
        properties: {
            source: {
                type: 'string',
                description: 'Absolute URL of the audio file to play',
            },
            loop: {
                type: 'number',
                description: 'Number of times to loop. Default 1. 0 means play once without looping.',
            },
            preemptible: {
                type: 'boolean',
                description: 'Whether subsequent outbound messages can preempt this playback',
            },
            interruptible: {
                type: 'boolean',
                description: 'Whether caller speech can interrupt this playback',
            },
        },
        required: ['source'],
    },
    handler: args => {
        logOut('PlayMedia', `Called with: ${JSON.stringify(args)}`);

        if (!args.source) {
            return {
                success: false,
                message: 'Source URL is required to play media',
                source: '',
            };
        }

        const frame: PlayFrame = { type: 'play', source: args.source };
        if (args.loop !== undefined) frame.loop = args.loop;
        if (args.preemptible !== undefined) frame.preemptible = args.preemptible;
        if (args.interruptible !== undefined) frame.interruptible = args.interruptible;

        return {
            success: true,
            message: 'Media playback initiated successfully',
            source: args.source,
            outgoingMessage: frame,
        };
    },
});
