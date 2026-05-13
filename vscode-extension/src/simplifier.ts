import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import * as os from 'os';

export class OnnxSimplifier {
    private extensionPath: string;

    constructor(extensionPath: string) {
        this.extensionPath = extensionPath;
    }

    public async simplify(
        modelPath: string,
        progress: vscode.Progress<{ message?: string; increment?: number }>
    ): Promise<{ success: boolean; simplifiedPath?: string; sizeReduction?: number; timeTaken?: number; error?: string }> {
        const startTime = Date.now();
        
        try {
            const originalSize = fs.statSync(modelPath).size;
            const threshold = vscode.workspace.getConfiguration('fastron').get('onnxSimplification.thresholdMB', 50) * 1024 * 1024;

            if (originalSize < threshold) {
                return { success: false, error: 'Model size is below the simplification threshold.' };
            }

            progress.report({ message: "Starting ONNX simplification..." });

            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fastron-simplify-'));
            const simplifiedFileName = path.basename(modelPath).replace('.onnx', '_simplified.onnx');
            const simplifiedPath = path.join(tempDir, simplifiedFileName);

            const sizeGB = originalSize / (1024 * 1024 * 1024);
            const pythonPath = vscode.workspace.getConfiguration('fastron').get('onnxSimplification.pythonPath', 'python3');
            
            const scriptPath = path.join(this.extensionPath, 'onnxsim_large_model', 'simplify_large_onnx.py');
            const args = [scriptPath, modelPath, simplifiedPath];
            
            progress.report({ message: "Spawning simplification script..." });

            const process = spawn(pythonPath, args);

            let stderr = '';
            process.stderr.on('data', (data) => {
                const message = data.toString();
                stderr += message;
                const lastLine = message.trim().split('\n').pop() || '';
                progress.report({ message: lastLine });
                console.log(`[ONNX Simplifier]: ${lastLine}`);
            });

            let stdout = '';
            process.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            const exitCode = await new Promise<number | null>((resolve) => {
                process.on('close', resolve);
                process.on('error', (err) => {
                    console.error('Failed to start simplification process.', err);
                    resolve(null);
                });
            });
            
            if (exitCode === null || exitCode !== 0) {
                fs.rmSync(tempDir, { recursive: true, force: true });
                const errorMessage = `Simplification script failed with exit code ${exitCode}.\nSTDERR:\n${stderr}\nSTDOUT:\n${stdout}`;
                return { success: false, error: errorMessage };
            }

            if (!fs.existsSync(simplifiedPath)) {
                fs.rmSync(tempDir, { recursive: true, force: true });
                const errorMessage = `Simplified model not found at ${simplifiedPath}.\nSTDERR:\n${stderr}\nSTDOUT:\n${stdout}`;
                return { success: false, error: errorMessage };
            }
            
            const simplifiedSize = fs.statSync(simplifiedPath).size;
            const sizeReduction = ((originalSize - simplifiedSize) / originalSize) * 100;
            const timeTaken = Date.now() - startTime;

            return {
                success: true,
                simplifiedPath,
                sizeReduction,
                timeTaken
            };

        } catch (error: any) {
            return { success: false, error: error.message };
        }
    }
}