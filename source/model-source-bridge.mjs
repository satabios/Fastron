import { ModelSource } from './model-source.mjs';

export const createBridge = (vscode, model) => {
    let listener = null;
    return new ModelSource({
        addEventListener(type, callback) {
            if (type === 'message') {
                listener = (event) => {
                    if (event.data.command === 'model_source_result' && event.data.model === model) {
                        callback({ data: event.data.response });
                    }
                };
                window.addEventListener('message', listener);
            }
        },
        postMessage(request) {
            vscode.postMessage({ command: 'model_source', model, request });
        },
        terminate() {
            window.removeEventListener('message', listener);
        }
    });
};
