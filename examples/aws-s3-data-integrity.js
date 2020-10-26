const WebpackAssetsManifest = require('webpack-assets-manifest');

const manifest = new WebpackAssetsManifest({
  output: 'aws-s3-data-integrity-manifest.json',
  integrity: true,
  integrityHashes: [ 'md5' ],
  integrityPropertyName: 'md5',
  publicPath: 's3://some-bucket/some-folder/',
  customize(entry, original, manifest, asset) {
    const md5 = asset && asset.info[ manifest.options.integrityPropertyName ];

    return {
      key: entry.value,
      value: md5 && md5.substring(4),
    };
  },
});
