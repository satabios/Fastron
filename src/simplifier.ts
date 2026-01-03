import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import * as vscode from 'vscode';

/**
 * ONNX Model Simplifier
 * Integrates onnxsim for small models and onnxsim_large_model for >2GB models
 * Reduces model complexity for faster viewing with minimal memory usage
 */

export interface SimplifierConfig {
    enabled: boolean;
    pythonPath: string;
    sizeThresholdMB: number;
    largeModelThresholdGB: number;
    inputShapes?: Record<string, number[]>;
    skipOptimizers?: string[];
}

export interface SimplificationResult {
    success: boolean;
    simplifiedPath?: string;
    originalPath: string;
    error?: string;
    timeTaken?: number;
    sizeReduction?: number;
}

export class OnnxSimplifier {
    private config: SimplifierConfig;
    private extensionPath: string;
    private tempDir: string | null = null;

    constructor(extensionPath: string, config?: Partial<SimplifierConfig>) {
        this.extensionPath = extensionPath;
        
        // Load configuration from VSCode settings
        const vscodeConfig = vscode.workspace.getConfiguration('vscode-netron');
        
        this.config = {
            enabled: config?.enabled ?? vscodeConfig.get('onnxSimplification.enabled', true),
            pythonPath: config?.pythonPath ?? vscodeConfig.get('onnxSimplification.pythonPath', 'python3'),
            sizeThresholdMB: config?.sizeThresholdMB ?? vscodeConfig.get('onnxSimplification.sizeThresholdMB', 50),
            largeModelThresholdGB: config?.largeModelThresholdGB ?? vscodeConfig.get('onnxSimplification.largeModelThresholdGB', 2),
            inputShapes: config?.inputShapes ?? vscodeConfig.get('onnxSimplification.inputShapes', {}),
            skipOptimizers: config?.skipOptimizers ?? vscodeConfig.get('onnxSimplification.skipOptimizers', [])
        };
    }

    /**
     * Simplify an ONNX model
     * @param modelPath Path to the ONNX model file
     * @param progress Optional progress callback
     * @returns SimplificationResult
     */
    async simplify(
        modelPath: string, 
        progress?: vscode.Progress<{ message?: string; increment?: number }>
    ): Promise<SimplificationResult> {
        const startTime = Date.now();
        
        try {
            // Check if simplification is enabled
            if (!this.config.enabled) {
                return {
                    success: false,
                    originalPath: modelPath,
                    error: 'Simplification is disabled'
                };
            }

            // Get file size
            const stats = fs.statSync(modelPath);
            const sizeMB = stats.size / (1024 * 1024);
            const sizeGB = sizeMB / 1024;

            // Check if file exceeds size threshold
            if (sizeMB < this.config.sizeThresholdMB) {
                return {
                    success: false,
                    originalPath: modelPath,
                    error: `Model size ${sizeMB.toFixed(2)}MB below threshold ${this.config.sizeThresholdMB}MB`
                };
            }

            if (progress) {
                progress.report({ message: `Simplifying ${sizeMB.toFixed(2)}MB model...`, increment: 10 });
            }

            // Create temporary directory
            this.tempDir = this.createTempDir();

            // Determine which simplification approach to use
            const useLargeModelSimplifier = sizeGB >= this.config.largeModelThresholdGB;
            
            let result: SimplificationResult;
            if (useLargeModelSimplifier) {
                result = await this.simplifyLargeModel(modelPath, this.tempDir, progress);
            } else {
                result = await this.simplifyStandardModel(modelPath, this.tempDir, progress);
            }

            result.timeTaken = Date.now() - startTime;
            
            if (result.success && result.simplifiedPath) {
                const simplifiedStats = fs.statSync(result.simplifiedPath);
                result.sizeReduction = ((stats.size - simplifiedStats.size) / stats.size) * 100;
            }

            return result;

        } catch (error: any) {
            return {
                success: false,
                originalPath: modelPath,
                error: error.message,
                timeTaken: Date.now() - startTime
            };
        }
    }

    /**
     * Simplify using onnxsim (for models < 2GB)
     */
    private async simplifyStandardModel(
        modelPath: string,
        outputDir: string,
        progress?: vscode.Progress<{ message?: string; increment?: number }>
    ): Promise<SimplificationResult> {
        const outputPath = path.join(outputDir, 'simplified.onnx');

        const args = [
            '-m', 'onnxsim',
            modelPath,
            outputPath
        ];

        if (Object.keys(this.config.inputShapes || {}).length > 0) {
            args.push('--input-shape', JSON.stringify(this.config.inputShapes));
        }

        return this.executePython(args, modelPath, outputPath, progress);
    }

    /**
     * Simplify using onnxsim_large_model (for models >= 2GB)
     */
    private async simplifyLargeModel(
        modelPath: string,
        outputDir: string,
        progress?: vscode.Progress<{ message?: string; increment?: number }>
    ): Promise<SimplificationResult> {
        const outputPath = path.join(outputDir, 'simplified.onnx');
        const scriptPath = path.join(this.extensionPath, 'onnxsim_large_model', 'simplify_large_onnx.py');

        if (!fs.existsSync(scriptPath)) {
            return {
                success: false,
                originalPath: modelPath,
                error: `Large model simplifier script not found: ${scriptPath}`
            };
        }

        const args = [
            scriptPath,
            '-m', modelPath,
            '-o', outputPath
        ];

        if (Object.keys(this.config.inputShapes || {}).length > 0) {
            args.push('--input_shape', JSON.stringify(this.config.inputShapes));
        }

        if (this.config.skipOptimizers && this.config.skipOptimizers.length > 0) {
            args.push('--skip', this.config.skipOptimizers.join(';'));
        }

        return this.executePython(args, modelPath, outputPath, progress);
    }

    /**
     * Execute Python subprocess
     */
    private executePython(
        args: string[],
        originalPath: string,
        outputPath: string,
        progress?: vscode.Progress<{ message?: string; increment?: number }>
    ): Promise<SimplificationResult> {
        return new Promise((resolve) => {
            let stdout = '';
            let stderr = '';

            const pythonProcess = spawn(this.config.pythonPath, args);

            pythonProcess.stdout.on('data', (data) => {
                stdout += data.toString();
                if (progress) {
                    progress.report({ message: 'Simplifying...', increment: 5 });
                }
            });

            pythonProcess.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            pythonProcess.on('close', (code) => {
                if (code === 0 && fs.existsSync(outputPath)) {
                    resolve({
                        success: true,
                        simplifiedPath: outputPath,
                        originalPath: originalPath
                    });
                } else {
                    resolve({
                        success: false,
                        originalPath: originalPath,
                        error: `Python process exited with code ${code}. ${stderr || stdout}`
                    });
                }
            });

            pythonProcess.on('error', (error) => {
                resolve({
                    success: false,
                    originalPath: originalPath,
                    error: `Failed to spawn Python: ${error.message}. Check pythonPath in settings.`
                });
            });
        });
    }

    /**
     * Create temporary directory for simplification
     */
    private createTempDir(): string {
        const tempBase = path.join(os.tmpdir(), 'vscode-netron-simplify');
        if (!fs.existsSync(tempBase)) {
            fs.mkdirSync(tempBase, { recursive: true });
        }
        
        const tempDir = path.join(tempBase, crypto.randomBytes(8).toString('hex'));
        fs.mkdirSync(tempDir, { recursive: true });
        
        return tempDir;
    }

    /**
     * Clean up temporary files
     */
    cleanup(): void {
        if (this.tempDir && fs.existsSync(this.tempDir)) {
            try {
                fs.rmSync(this.tempDir, { recursive: true, force: true });
                this.tempDir = null;
            } catch (error) {
                console.error('Failed to cleanup temp directory:', error);
            }
        }
    }

    /**
     * Check if Python and required packages are available
     */
    async checkDependencies(): Promise<{ available: boolean; message: string }> {
        return new Promise((resolve) => {
            const pythonProcess = spawn(this.config.pythonPath, ['-c', 'import onnx, onnxsim; print("OK")']);
            
            let output = '';
            pythonProcess.stdout.on('data', (data) => {
                output += data.toString();
            });

            pythonProcess.on('close', (code) => {
                if (code === 0 && output.includes('OK')) {
                    resolve({ available: true, message: 'Python and required packages are available' });
                } else {
                    resolve({ 
                        available: false, 
                        message: 'Please install required packages: pip install onnx onnxsim' 
                    });
                }
            });

            pythonProcess.on('error', () => {
                resolve({ 
                    available: false, 
                    message: `Python not found at: ${this.config.pythonPath}. Please configure pythonPath in settings.` 
                });
            });
        });
    }
}
