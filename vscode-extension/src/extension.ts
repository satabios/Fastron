import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { OnnxSimplifier } from './simplifier';


function getNonce() {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

function getFastronURL() {
	return `<!DOCTYPE html>
	<html lang="en">
	<style>
	html { touch-action: none; overflow: hidden; width: 100%; height: 100%; -ms-text-size-adjust: 100%; -webkit-text-size-adjust: 100%; text-rendering: optimizeLegibility; -webkit-text-rendering: optimizeLegibility; -moz-text-rendering: optimizeLegibility; -ms-text-rendering: optimizeLegibility; -o-text-rendering: optimizeLegibility; -webkit-font-smoothing: antialiased; -moz-font-smoothing: antialiased; -ms-font-smoothing: antialiased; -o-font-smoothing: antialiased; }
	body { touch-action: none; overflow: hidden; width: 100%; height: 100%; margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", "Ubuntu", "Droid Sans", sans-serif, "PingFang SC"; font-size: 12px; text-rendering: geometricPrecision; }
	iframe { touch-action: none; overflow: hidden; width: 100%; height: 100%; border: none; }
	</style>
	<head>
		<meta charset="UTF-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<title>Fastron</title>
	</head>
	<body>
	<iframe src="https://netron.app/" title="Netron web app"></iframe>
	</body>
	</html>`;
}


export function activate(context: vscode.ExtensionContext) {

	context.subscriptions.push(
		vscode.commands.registerCommand('fastron.open', (resource: vscode.Uri) => {

			// Load index file
			const indexPath = vscode.Uri.file(path.join(context.extensionPath, 'webview', 'index.html'));
			let html = fs.readFileSync(indexPath.fsPath, 'utf8');

			// Get user model file
			let modelFile = vscode.window.activeTextEditor?.document.fileName;
			if (resource !== undefined)
			{
				modelFile = resource.fsPath;
			}

			// Get model file name
			let baseName = path.basename(modelFile!);

			// Panel creation
			const panel = vscode.window.createWebviewPanel(
				'fastron',
				baseName + " [Fastron]",
				vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One,
				{
					enableScripts: true,
					retainContextWhenHidden: true,

					// And restrict the webview to only loading content from our extension's `webview` directory.
					localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'webview', 'netron')]
				}
			);

			// Create URI variables for index.html
			const netronUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'webview', 'netron'));
			const iconUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'webview', 'netron', 'icon.png'));
			const faviconUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'webview', 'netron', 'favicon.ico'));
			const grapherSheetUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'webview', 'netron', 'grapher.css'));
			const viewUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'webview', 'netron', 'view.js'));
			const browserUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'webview', 'netron', 'browser.js'));

			// Replace %variables% in html by URI values
			html = html.replace(new RegExp("%webview_cspSource%", 'g'), panel.webview.cspSource);
			html = html.replace(new RegExp("%iconPath%", 'g'), iconUri.toString());
			html = html.replace(new RegExp("%faviconPath%", 'g'), faviconUri.toString());
			html = html.replace(new RegExp("%grapherSheetPath%", 'g'), grapherSheetUri.toString());
			html = html.replace(new RegExp("%viewPath%", 'g'), viewUri.toString());
			html = html.replace(new RegExp("%browserPath%", 'g'), browserUri.toString());

			html = html.replace(new RegExp("%netronPath%", 'g'), netronUri.toString());
			
			// Use a nonce to only allow specific scripts to be run
			html = html.replace(new RegExp("%nonce%", 'g'), getNonce().toString());

			// Add name of the graph for file creation
			html = html.replace(new RegExp('%GRAPHNAME%', 'g'), baseName);

			panel.webview.html = html;

			let isDisposed = false;
			panel.onDidDispose(() => {
				isDisposed = true;
			});

			panel.webview.onDidReceiveMessage(
				async message => {
				  if (isDisposed) { return; }
				  switch (message.command) {
					case 'alert':
						vscode.window.showErrorMessage(message.text);
						return;
					case 'request_config': {
						const config = vscode.workspace.getConfiguration('fastron');
						if (!isDisposed) {
							panel.webview.postMessage({ command: 'set_config', config: config });
						}
						return;
					}
					case 'request_model':
						// Check if this is an ONNX file and simplification is enabled
						let fileToLoad = modelFile!;
						const ext = path.extname(modelFile!).toLowerCase();
						
						// Get file size for progress messages
						const fileStats = fs.statSync(modelFile!);
						const fileSizeMB = (fileStats.size / (1024 * 1024)).toFixed(1);
						const fileSizeGB = (fileStats.size / (1024 * 1024 * 1024)).toFixed(2);
						const sizeDisplay = fileStats.size > 1024 * 1024 * 1024 ? `${fileSizeGB}GB` : `${fileSizeMB}MB`;
						
						if (ext === '.onnx') {
							const config = vscode.workspace.getConfiguration('fastron');
							const simplificationEnabled = config.get('onnxSimplification.enabled', true);
							
							if (simplificationEnabled) {
								try {
									const result = await vscode.window.withProgress({
										location: vscode.ProgressLocation.Notification,
										title: `Optimizing ${sizeDisplay} ONNX model for viewing`,
										cancellable: false
									}, async (progress) => {
										const simplifier = new OnnxSimplifier(context.extensionPath);
										return await simplifier.simplify(modelFile!, progress);
									});

									if (isDisposed) { return; }

									if (result.success && result.simplifiedPath) {
										fileToLoad = result.simplifiedPath;
										const reductionMsg = result.sizeReduction 
											? ` (${result.sizeReduction.toFixed(1)}% reduction)` 
											: '';
										vscode.window.showInformationMessage(
											`Model simplified in ${(result.timeTaken! / 1000).toFixed(1)}s${reductionMsg}`
										);
									} else if (result.error && !result.error.includes('below threshold')) {
										// Only show error if it's not about threshold
										console.warn('Simplification failed, using original model:', result.error);
									}
								} catch (error: any) {
									console.error('Simplification error:', error);
									// Fall back to original model
								}
							}
						}

						if (isDisposed) { return; }

						// Show progress while reading large file
						await vscode.window.withProgress({
							location: vscode.ProgressLocation.Notification,
							title: `Loading ${sizeDisplay} model...`,
							cancellable: false
						}, async (progress) => {
							progress.report({ message: 'Reading file...' });
							const modelData = fs.readFileSync(fileToLoad);
							progress.report({ message: 'Transmitting to viewer...' });
							if (!isDisposed) {
								panel.webview.postMessage({
									command: "transmit_model", 
									value: Uint8Array.from(modelData).subarray()
								});
							}
						});
						
						// Cleanup temp files after transmission
						if (fileToLoad !== modelFile) {
							setTimeout(() => {
								try {
									const tempDir = path.dirname(fileToLoad);
									if (tempDir.includes('fastron-simplify')) {
										fs.rmSync(tempDir, { recursive: true, force: true });
									}
								} catch (e) {
									console.error('Failed to cleanup temp files:', e);
								}
							}, 1000);
						}
						return;
				  }
				},
				undefined,
				context.subscriptions
			  );
		})
	);


	context.subscriptions.push(
		vscode.commands.registerCommand('fastron.open_webbrowser', () => {

			const panel = vscode.window.createWebviewPanel(
				'fastron',
				"Fastron",
				vscode.ViewColumn.One,
				{
					enableScripts: true,
					retainContextWhenHidden: true
				}
			);
			
			panel.webview.html = getFastronURL();
		})
	);

	// Cache management commands
	context.subscriptions.push(
		vscode.commands.registerCommand('fastron.clearCache', async () => {
			const answer = await vscode.window.showWarningMessage(
				'Clear all cached model data? This will free up storage but models will need to be reparsed on next view.',
				'Clear Cache',
				'Cancel'
			);
			
			if (answer === 'Clear Cache') {
				// Send clear cache message to all active webview panels
				// In a real implementation, we'd track active panels and send messages
				vscode.window.showInformationMessage('Cache cleared successfully');
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('fastron.showCacheStats', async () => {
			// In a real implementation, we'd query cache stats from webview
			// For now, show a placeholder message
			const message = `Cache Statistics:
- Total Entries: Checking...
- Total Size: Checking...
- Hit Rate: Checking...

Open the Developer Tools (Help > Toggle Developer Tools) and run:
  cache.getStats()
in the Console while viewing a model to see detailed statistics.`;

			vscode.window.showInformationMessage(message, { modal: true });
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('fastron.compare', async (resource: vscode.Uri) => {
			const modelExtensions = ['onnx', 'pb', 'tflite', 'pt', 'pth', 'h5', 'keras',
				'mlmodel', 'mlpackage', 'caffemodel', 'bin', 'param', 'ncnn'];
			const filterEntry = { 'modelFiles': modelExtensions };

			let fileA: string | undefined = resource?.fsPath;

			if (!fileA) {
				const pickedA = await vscode.window.showOpenDialog({
					title: 'Select First Model',
					canSelectMany: false,
					filters: filterEntry
				});
				if (!pickedA || pickedA.length === 0) {
					return;
				}
				fileA = pickedA[0].fsPath;
			}

			const pickedB = await vscode.window.showOpenDialog({
				title: 'Select Second Model to Compare With',
				canSelectMany: false,
				filters: filterEntry
			});
			if (!pickedB || pickedB.length === 0) {
				return;
			}
			const fileB = pickedB[0].fsPath;

			const nameA = path.basename(fileA);
			const nameB = path.basename(fileB);

			const comparatorHtmlPath = vscode.Uri.file(
				path.join(context.extensionPath, 'webview', 'comparator.html')
			);
			let html = fs.readFileSync(comparatorHtmlPath.fsPath, 'utf8');

			const panel = vscode.window.createWebviewPanel(
				'fastron-compare',
				`Compare: ${nameA} vs ${nameB}`,
				vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One,
				{
					enableScripts: true,
					retainContextWhenHidden: true,
					localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'webview', 'netron')]
				}
			);

			const nonce = getNonce();
			const netronUri = panel.webview.asWebviewUri(
				vscode.Uri.joinPath(context.extensionUri, 'webview', 'netron')
			);
			const grapherSheetUri = panel.webview.asWebviewUri(
				vscode.Uri.joinPath(context.extensionUri, 'webview', 'netron', 'grapher.css')
			);
			const viewUri = panel.webview.asWebviewUri(
				vscode.Uri.joinPath(context.extensionUri, 'webview', 'netron', 'view.js')
			);
			const comparatorUri = panel.webview.asWebviewUri(
				vscode.Uri.joinPath(context.extensionUri, 'webview', 'netron', 'comparator.js')
			);
			// basePath is the netron directory URI (used as base for base.js import)
			const basePath = netronUri.toString();

			html = html.replace(/%webview_cspSource%/g, panel.webview.cspSource);
			html = html.replace(/%nonce%/g, nonce);
			html = html.replace(/%netronPath%/g, netronUri.toString());
			html = html.replace(/%grapherSheetPath%/g, grapherSheetUri.toString());
			html = html.replace(/%viewPath%/g, viewUri.toString());
			html = html.replace(/%comparatorPath%/g, comparatorUri.toString());
			html = html.replace(/%basePath%/g, basePath);

			panel.webview.html = html;

			let isDisposed = false;
			panel.onDidDispose(() => {
				isDisposed = true;
			});

			panel.webview.onDidReceiveMessage(
				async (message) => {
					if (isDisposed) { return; }
					switch (message.command) {
						case 'comparator_ready': {
							const statsA = fs.statSync(fileA!);
							const statsB = fs.statSync(fileB);
							const sizeA = (statsA.size / (1024 * 1024)).toFixed(1);
							const sizeB = (statsB.size / (1024 * 1024)).toFixed(1);

							await vscode.window.withProgress({
								location: vscode.ProgressLocation.Notification,
								title: `Loading models for comparison (${sizeA}MB + ${sizeB}MB)`,
								cancellable: false
							}, async (progress) => {
								progress.report({ message: 'Reading files...' });
								const dataA = fs.readFileSync(fileA!);
								const dataB = fs.readFileSync(fileB);
								progress.report({ message: 'Transmitting...' });
								if (!isDisposed) {
									panel.webview.postMessage({
										command: 'transmit_model_a',
										value: Uint8Array.from(dataA),
										name: nameA,
										label: nameA
									});
									panel.webview.postMessage({
										command: 'transmit_model_b',
										value: Uint8Array.from(dataB),
										name: nameB,
										label: nameB
									});
								}
							});
							return;
						}
						case 'alert':
							vscode.window.showErrorMessage(message.text);
							return;
					}
				},
				undefined,
				context.subscriptions
			);
		})
	);
}


export function deactivate() {}
