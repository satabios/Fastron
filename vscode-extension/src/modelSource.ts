import * as path from 'path';
import { Worker } from 'worker_threads';
import * as vscode from 'vscode';

// Runs beside the file, including inside a Remote SSH extension host.
export class ModelSource {
    private worker: Worker;
    private next = 0;
    private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    private closed = false;

    constructor(extensionPath: string) {
        this.worker = new Worker(path.join(extensionPath, 'webview', 'netron', 'model-source-worker.mjs'));
        this.worker.on('message', (message) => {
            const pending = this.pending.get(message.id);
            this.pending.delete(message.id);
            if (pending) {
                if (message.error) { pending.reject(new Error(message.error)); }
                else { pending.resolve(message.result); }
            }
        });
        this.worker.on('error', (error) => this.dispose(error));
        this.worker.on('exit', () => this.dispose());
    }

    request(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
        if (this.closed) { return Promise.reject(new Error('Model source is closed.')); }
        const id = ++this.next;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.worker.postMessage({ ...args, id, command });
        });
    }

    async respond(webview: vscode.Webview, model: string, request: Record<string, unknown>) {
        const response: { id: unknown; result?: unknown; error?: string } = { id: request.id };
        try {
            if (!['read', 'index', 'stats'].includes(String(request.command))) {
                throw new Error('Unsupported model source request.');
            }
            response.result = await this.request(String(request.command), request);
        } catch (error) {
            response.error = error instanceof Error ? error.message : String(error);
        }
        await webview.postMessage({ command: 'model_source_result', model, response });
    }

    dispose(error = new Error('Model source was closed.')) {
        if (this.closed) { return; }
        this.closed = true;
        this.pending.forEach((pending) => pending.reject(error));
        this.pending.clear();
        void this.worker.terminate();
    }
}
