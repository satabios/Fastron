<div align="center">
<img width="400px" height="100px" src="https://github.com/satabios/Fastron/raw/experiment/.github/logo-light.svg#gh-light-mode-only">
<img width="400px" height="100px" src="https://github.com/satabios/Fastron/raw/experiment/.github/logo-dark.svg#gh-dark-mode-only">
</div>

# Fastron - Optimized Neural Network Visualizer

Fastron is a high-performance viewer for neural network, deep learning and machine learning models. This is an optimized fork of [Netron](https://github.com/lutzroeder/netron) with significant performance enhancements for working with large models.

## Overview


Fastron supports ONNX, TensorFlow Lite, PyTorch, torch.export, ExecuTorch, Core ML, Keras, Caffe, Darknet, TensorFlow.js, Safetensors and NumPy.

Fastron has experimental support for TorchScript, MLIR, TensorFlow, OpenVINO, RKNN, ncnn, MNN, PaddlePaddle, GGUF and scikit-learn.

### Performance Features in Action

**On-Demand Weight Loading:**

![On-Demand Weight Loading](https://github.com/satabios/Fastron/raw/experiment/gifs/On-Demand-Weight-Loading.gif)

**On-The-Fly Node Loading:**

![On-The-Fly Node Loading](https://github.com/satabios/Fastron/raw/experiment/gifs/On-The-Fly-Node-Loading.gif)


**Model Comparator:**

![On-The-Fly Node Loading](https://github.com/satabios/Fastron/raw/experiment/gifs/Model-Comparator.gif)


## Key Features & Optimizations

### Performance Enhancements

This optimized fork introduces several critical performance improvements:

- **On-the-Fly Node & Edge Loading**: Models load dynamically as you navigate. Only the currently visible nodes and edges are rendered, dramatically improving initial load times and memory usage for large models.
  
- **Weight Toggle Button**: Easily toggle the display of model weights on/off to reduce visual clutter and improve performance when analyzing model architecture without weight details.

- **Weight Disabling**: Disable weight data loading entirely for ultra-fast model visualization. When disabled, weight tensors are **not parsed** during model loading — only metadata (shape, type, name) is extracted. Weight data can be loaded on demand per-tensor when needed, without reloading the entire model. Perfect for quickly understanding model topology without the overhead of loading weight tensors.

- **Incremental Rendering**: The visualization uses progressive rendering to ensure responsiveness even with massive neural networks containing millions of nodes.

- **Memory Optimizations**: Efficient data structures and lazy-loading strategies minimize memory footprint while maintaining full feature functionality.

- **Model Comparison**: Visually compare two models side by side, with a common panning element for better comprehension.

### Standard Features

- **Multiple Format Support**: View models across 40+ neural network framework formats
- **Interactive Visualization**: Zoom, pan, and inspect model architecture in detail
- **Metadata Display**: View layer properties, operations, and data flow information
- **Cross-Platform**: Available as browser app, desktop applications, and Python package

## Install

**Browser**: [**Start**](https://netron.app) the browser version.

**macOS**: [**Download**](https://github.com/satabios/netron/releases/latest) the `.dmg` file or run `brew install --cask fastron`.

**Linux**: [**Download**](https://github.com/satabios/netron/releases/latest) the `.deb` or `.rpm` file.

**Windows**: [**Download**](https://github.com/satabios/netron/releases/latest) the `.exe` installer or run `winget install -s winget fastron`.

**Python**: `pip install fastron`, then run `fastron [FILE]` or `fastron.start('[FILE]')`.

## Citation

This project is an optimized fork of [Netron](https://github.com/lutzroeder/netron) by Lutz Roeder. Netron is an excellent open-source neural network visualizer that has been enhanced with performance optimizations for handling extremely large models.

If you use Fastron, please consider crediting the original Netron project:

```bibtex
@software{netron,
  author = {Lutz Roeder},
  title = {Netron: Visualizer for neural network, deep learning and machine learning models},
  url = {https://github.com/lutzroeder/netron},
  year = {2018}
}
```

And my optimizations:

```bibtex
@software{fastron,
  title = {Fastron: Performance-Optimized Neural Network Visualizer},
  url = {https://github.com/satabios/netron},
  year = {2026}
}
```
