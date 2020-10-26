const WebpackAssetsManifest = require('webpack-assets-manifest');

const manifest = new WebpackAssetsManifest({
  output: 'asset-integrity-manifest.json',
  integrity: true,
  publicPath: true,
  customize(entry, original, manifest, asset) {
    const integrity = asset && asset.info[ manifest.options.integrityPropertyName ];

    return {
      key: entry.value,
      value: integrity,
    };
  },
});
