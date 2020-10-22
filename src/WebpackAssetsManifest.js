/**
 * Webpack Assets Manifest
 *
 * @author Eric King <eric@webdeveric.com>
 */

const fs = require('fs');
const url = require('url');
const path = require('path');
const get = require('lodash.get');
const has = require('lodash.has');
const { validate } = require('schema-utils');
const { SyncHook, SyncWaterfallHook } = require('tapable');
const { Compilation, NormalModule, sources: { RawSource } } = require('webpack');

/** @type {object} */
const optionsSchema = require('./options-schema.json');
const {
  maybeArrayWrap,
  filterHashes,
  getSRIHash,
  warn,
  varType,
  isObject,
  getSortedObject,
  templateStringToRegExp,
  findMapKeysByValue,
  lock,
  unlock,
  lockSync,
  unlockSync,
} = require('./helpers.js');

const IS_MERGING = Symbol('isMerging');
const COMPILATION_COUNTER = Symbol('compilationCounter');
const PLUGIN_NAME = 'WebpackAssetsManifest';

class WebpackAssetsManifest
{
  /**
   * @param {object} options - configuration options
   * @constructor
   */
  constructor(options = {})
  {
    /**
     * This is using hooks from {@link https://github.com/webpack/tapable Tapable}.
     */
    this.hooks = Object.freeze({
      apply: new SyncHook([ 'manifest' ]),
      customize: new SyncWaterfallHook([ 'entry', 'original', 'manifest', 'asset' ]),
      transform: new SyncWaterfallHook([ 'assets', 'manifest' ]),
      done: new SyncHook([ 'manifest', 'stats' ]),
      options: new SyncWaterfallHook([ 'options' ]),
      afterOptions: new SyncHook([ 'options' ]),
    });

    this.hooks.transform.tap(PLUGIN_NAME, assets => {
      const { sortManifest } = this.options;

      return sortManifest ? getSortedObject(
        assets,
        typeof sortManifest === 'function' ? sortManifest.bind(this) : undefined
      ) : assets;
    });

    this.hooks.afterOptions.tap(PLUGIN_NAME, options => {
      this.options = Object.assign( this.defaultOptions, options );
      this.options.integrityHashes = filterHashes( this.options.integrityHashes );

      validate(optionsSchema, this.options, { name: PLUGIN_NAME });

      this.options.output = path.normalize( this.options.output );

      // Copy over any entries that may have been added to the manifest before apply() was called.
      // If the same key exists in assets and options.assets, options.assets should be used.
      this.assets = Object.assign(this.options.assets, this.assets, this.options.assets);

      [ 'apply', 'customize', 'transform', 'done' ].forEach( hookName => {
        if ( typeof this.options[ hookName ] === 'function' ) {
          this.hooks[ hookName ].tap(`${PLUGIN_NAME}.option.${hookName}`, this.options[ hookName ] );
        }
      });
    });

    this.options = Object.assign( this.defaultOptions, options );

    // This is what gets JSON stringified
    this.assets = this.options.assets;

    // original filename : hashed filename
    this.assetNames = new Map();

    // This is passed to the customize() hook
    this.currentAsset = null;

    // The Webpack compiler instance
    this.compiler = null;

    // This is used to identify hot module replacement files
    this.hmrRegex = null;

    // Is a merge happening?
    this[ IS_MERGING ] = false;

    this[ COMPILATION_COUNTER ] = 0;
  }

  /**
   * Hook into the Webpack compiler
   *
   * @param  {object} compiler - The Webpack compiler object
   */
  apply(compiler)
  {
    if ( ! this.options.enabled ) {
      return;
    }

    this.compiler = compiler;

    // Allow hooks to modify options
    this.options = this.hooks.options.call(this.options);

    // Ensure options contain defaults and are valid
    this.hooks.afterOptions.call(this.options);

    const { output: { filename, hotUpdateChunkFilename } } = compiler.options;

    if ( filename !== hotUpdateChunkFilename && typeof hotUpdateChunkFilename === 'string' ) {
      this.hmrRegex = templateStringToRegExp( hotUpdateChunkFilename, 'i' );
    }

    compiler.hooks.beforeRun.tap(PLUGIN_NAME, this.handleBeforeRun.bind(this));

    compiler.hooks.watchRun.tap(PLUGIN_NAME, this.handleBeforeRun.bind(this));

    compiler.hooks.compilation.tap(PLUGIN_NAME, this.handleCompilation.bind(this));

    // Use fs to write the manifest.json to disk if `options.writeToDisk` is true
    compiler.hooks.afterEmit.tapPromise(PLUGIN_NAME, this.handleAfterEmit.bind(this));

    // The compilation has finished
    compiler.hooks.done.tap(PLUGIN_NAME, stats => this.hooks.done.call(this, stats));

    // Setup is complete.
    this.hooks.apply.call(this);
  }

  /**
   * Get the default options.
   *
   * @return {object}
   */
  get defaultOptions()
  {
    return {
      enabled: true,
      assets: Object.create(null),
      output: 'assets-manifest.json',
      replacer: null, // Its easier to use the transform hook instead.
      space: 2,
      writeToDisk: 'auto',
      fileExtRegex: /\.\w{2,4}\.(?:map|gz)$|\.\w+$/i,
      sortManifest: true,
      merge: false,
      publicPath: null,
      contextRelativeKeys: false,

      // Hooks
      apply: null,     // After setup is complete
      customize: null, // Customize each entry in the manifest
      transform: null, // Transform the entire manifest
      done: null,      // Compilation is done and the manifest has been written

      // Include `compilation.entrypoints` in the manifest file
      entrypoints: false,
      entrypointsKey: 'entrypoints',

      // https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity
      integrity: false,
      integrityHashes: [ 'sha256', 'sha384', 'sha512' ],
      integrityPropertyName: 'integrity',
    };
  }

  /**
   * Determine if the manifest data is currently being merged.
   *
   * @return {boolean}
   */
  get isMerging()
  {
    return this[ IS_MERGING ];
  }

  /**
   * Get the file extension.
   *
   * @param  {string} filename
   * @return {string}
   */
  getExtension(filename)
  {
    if (! filename || typeof filename !== 'string') {
      return '';
    }

    filename = filename.split(/[?#]/)[ 0 ];

    if (this.options.fileExtRegex) {
      const ext = filename.match(this.options.fileExtRegex);

      return ext && ext.length ? ext[ 0 ] : '';
    }

    return path.extname(filename);
  }

  /**
   * Replace backslash with forward slash.
   *
   * @return {string}
   */
  fixKey(key)
  {
    return typeof key === 'string' ? key.replace( /\\/g, '/' ) : key;
  }

  /**
   * Determine if the filename matches the HMR filename pattern.
   *
   * @return {boolean}
   */
  isHMR(filename)
  {
    return this.hmrRegex ? this.hmrRegex.test( filename ) : false;
  }

  /**
   * Add item to assets without modifying the key or value.
   *
   * @param {string} key
   * @param {string} value
   * @return {object} this
   */
  setRaw(key, value)
  {
    this.assets[ key ] = value;

    return this;
  }

  /**
   * Add an item to the manifest.
   *
   * @param {string} key
   * @param {string} value
   * @return {object} this
   */
  set(key, value)
  {
    if ( this.isMerging && this.options.merge !== 'customize' ) {
      // Do not fix the key if merging since it should already be correct.
      return this.setRaw(key, value);
    }

    const fixedKey = this.fixKey(key);
    const publicPath = this.getPublicPath( value );

    const entry = this.hooks.customize.call(
      {
        key: fixedKey,
        value: publicPath,
      },
      {
        key,
        value,
      },
      this,
      this.currentAsset
    );

    // Allow the entry to be skipped
    if ( entry === false ) {
      return this;
    }

    // Use the customized values
    if ( isObject( entry ) ) {
      let { key = fixedKey, value = publicPath } = entry;

      // If the integrity should be returned but the entry value was
      // not customized lets do that now so it includes both.
      if ( value === publicPath && this.options.integrity ) {
        value = {
          src: value,
          integrity: get(this, `currentAsset.info.${this.options.integrityPropertyName}`, ''),
        };
      }

      return this.setRaw( key, value );
    }

    warn.once(`Unexpected customize() return type: ${varType(entry)}`);

    return this.setRaw( fixedKey, publicPath );
  }

  /**
   * Determine if an item exist in the manifest.
   *
   * @param {string} key
   * @return {boolean}
   */
  has(key)
  {
    return has(this.assets, key) || has(this.assets, this.fixKey(key));
  }

  /**
   * Get an item from the manifest.
   *
   * @param {string} key
   * @param {string} defaultValue - Defaults to empty string
   * @return {*}
   */
  get(key, defaultValue = undefined)
  {
    return this.assets[ key ] || this.assets[ this.fixKey(key) ] || defaultValue;
  }

  /**
   * Delete an item from the manifest.
   *
   * @param {string} key
   * @return {boolean}
   */
  delete(key)
  {
    if ( has(this.assets, key) ) {
      return (delete this.assets[ key ]);
    }

    key = this.fixKey(key);

    if ( has(this.assets, key) ) {
      return (delete this.assets[ key ]);
    }

    return false;
  }

  /**
   * Process compilation assets.
   *
   * @param  {object} assets - Assets by chunk name
   * @return {object}
   */
  processAssetsByChunkName(assets)
  {
    Object.keys(assets).forEach( chunkName => {
      maybeArrayWrap( assets[ chunkName ] )
        .filter( f => ! this.isHMR(f) ) // Remove hot module replacement files
        .forEach( filename => {
          this.assetNames.set( chunkName + this.getExtension( filename ), filename );
        });
    });

    return this.assetNames;
  }

  /**
   * Get the data for `JSON.stringify()`.
   *
   * @return {object}
   */
  toJSON()
  {
    // This is the last chance to modify the data before the manifest file gets created.
    return this.hooks.transform.call(this.assets, this);
  }

  /**
   * `JSON.stringify()` the manifest.
   *
   * @return {string}
   */
  toString()
  {
    return JSON.stringify(this, this.options.replacer, this.options.space) || '{}';
  }

  /**
   * Merge data if the output file already exists
   */
  maybeMerge()
  {
    if ( this.options.merge ) {
      try {
        this[ IS_MERGING ] = true;

        const data = JSON.parse( fs.readFileSync( this.getOutputPath(), { encoding: 'utf8' } ) );

        const deepmerge = require('deepmerge');

        const arrayMerge = (destArray, srcArray) => srcArray;

        for ( const [ key, oldValue ] of Object.entries( data ) ) {
          if ( this.has( key ) ) {
            const currentValue = this.get(key);

            if ( isObject( oldValue ) && isObject( currentValue ) ) {
              const newValue = deepmerge( oldValue, currentValue, { arrayMerge });

              this.set( key, newValue );
            }
          } else {
            this.set( key, oldValue );
          }
        }
      } catch (err) { // eslint-disable-line
      } finally {
        this[ IS_MERGING ] = false;
      }
    }
  }

  /**
   * @param {object} entrypoints from a compilation
   */
  getEntrypointFilesGroupedByExtension( entrypoints )
  {
    const findAssetKeys = findMapKeysByValue( this.assetNames );
    const removeHMR = f => ! this.isHMR(f);
    const groupFilesByExtension = (files, file) => {
      const ext = this.getExtension(file).replace(/^\.+/, '').toLowerCase();
      const matchingAssets = findAssetKeys(file).map( key => this.assets[ key ] || key );

      files[ ext ] = files[ ext ] || [];
      files[ ext ].push( ...matchingAssets );

      return files;
    };

    const grouped = Object.create(null);

    for ( const [ name, entrypoint ] of entrypoints ) {
      grouped[ name ] = entrypoint
        .getFiles()
        .filter( removeHMR )
        .reduce( groupFilesByExtension, Object.create(null) );
    }

    return grouped;
  }

  /**
   * Emit the assets manifest
   *
   * @param {object} compilation
   */
  emitAssetsManifest(compilation)
  {
    const output = this.getManifestPath(
      compilation,
      this.inDevServer() ?
        path.basename( this.options.output ) :
        path.relative( compilation.compiler.outputPath, this.getOutputPath() )
    );

    if ( this.options.merge ) {
      lockSync( output );
    }

    this.maybeMerge();

    compilation.emitAsset( output, new RawSource(this.toString(), false) );

    if ( this.options.merge ) {
      unlockSync( output );
    }
  }

  /**
   * Record details of Asset Modules
   *
   * @param {*} compilation
   */
  handleProcessAssetsAnalyse( compilation /* , assets */ )
  {
    const { contextRelativeKeys } = this.options;

    for ( const chunk of compilation.chunks ) {
      const modules = compilation.chunkGraph.getChunkModulesIterableBySourceType(
        chunk,
        'asset'
      );

      if ( modules ) {
        for ( const module of modules ) {
          const { assetInfo, filename } = module.buildInfo;
          const sourceFilename = contextRelativeKeys ?
            path.relative( compilation.compiler.context, module.userRequest ) :
            path.join( path.dirname(filename), path.basename(module.userRequest) );

          assetInfo.sourceFilename = sourceFilename;
          assetInfo.userRequest = module.userRequest;

          compilation.assetsInfo.set(filename, assetInfo);

          this.assetNames.set(sourceFilename, filename);
        }
      }
    }
  }

  /**
   * Gather asset details
   *
   * @param {object} compilation
   */
  handleAfterProcessAssets( compilation /* , assets */ )
  {
    const stats = compilation.getStats().toJson({
      all: false,
      assets: true,
    });

    this.processAssetsByChunkName( stats.assetsByChunkName );

    const findAssetKeys = findMapKeysByValue( this.assetNames );

    const { contextRelativeKeys } = this.options;

    for ( const asset of compilation.getAssets() ) {
      const sourceFilenames = findAssetKeys( asset.name );

      if ( ! sourceFilenames.length ) {
        const { sourceFilename } = asset.info;
        const name = sourceFilename ?
          ( contextRelativeKeys ? sourceFilename : path.basename( sourceFilename ) ) :
          asset.name;

        sourceFilenames.push( name );
      }

      sourceFilenames.forEach( key => {
        this.currentAsset = asset;

        this.set( key, asset.name );

        this.currentAsset = null;
      });
    }

    if ( this.options.entrypoints ) {
      const entrypoints = this.getEntrypointFilesGroupedByExtension( compilation.entrypoints );

      if ( this.options.entrypointsKey === false ) {
        for ( const key in entrypoints ) {
          this.setRaw( key, entrypoints[ key ] );
        }
      } else {
        this.setRaw( this.options.entrypointsKey, entrypoints );
      }
    }

    if ( --this[ COMPILATION_COUNTER ] === 0 ) {
      this.emitAssetsManifest(compilation);
    }
  }

  /**
   * Get the parsed output path. [hash] is supported.
   *
   * @param  {object} compilation - the Webpack compilation object
   * @param  {string} filename
   * @return {string}
   */
  getManifestPath(compilation, filename)
  {
    return compilation.getPath( filename, { chunk: { name: 'assets-manifest' }, filename: 'assets-manifest.json' } );
  }

  /**
   * Write the asset manifest to the file system.
   *
   * @param {string} destination
   */
  async writeTo(destination)
  {
    await lock( destination );

    await fs.promises.mkdir( path.dirname(destination), { recursive: true } );

    await fs.promises.writeFile( destination, this.toString() );

    await unlock( destination );
  }

  /**
   * Cleanup before running Webpack
   */
  handleBeforeRun()
  {
    this.assetNames.clear();
  }

  /**
   * Determine if the manifest should be written to disk with fs.
   *
   * @param {object} compilation
   * @return {boolean}
   */
  shouldWriteToDisk(compilation)
  {
    if ( this.options.writeToDisk === 'auto' ) {
      // Return true if using webpack-dev-server and the manifest output is above the compiler outputPath.
      return this.inDevServer() &&
        path.relative(
          this.compiler.outputPath,
          this.getManifestPath( compilation, this.getOutputPath() )
        ).startsWith('..');
    }

    return this.options.writeToDisk;
  }

  /**
   * Last chance to write the manifest to disk.
   *
   * @param  {object} compilation - the Webpack compilation object
   */
  async handleAfterEmit(compilation)
  {
    if ( this.shouldWriteToDisk(compilation) ) {
      await this.writeTo( this.getManifestPath( compilation, this.getOutputPath() ) );
    }
  }

  /**
   * Record asset names
   *
   * @param  {object} compilation
   * @param  {object} loaderContext
   * @param  {object} module
   */
  handleNormalModuleLoader(compilation, loaderContext, module)
  {
    const { emitFile } = loaderContext;
    const { contextRelativeKeys } = this.options;

    // assetInfo parameter was added in Webpack 5
    loaderContext.emitFile = (name, content, sourceMap, assetInfo) => {
      const info = Object.assign( {}, assetInfo );

      if ( this.getExtension( module.userRequest ) === this.getExtension( name ) ) {
        const sourceFilename = contextRelativeKeys ?
          path.relative( compilation.compiler.context, module.userRequest ) :
          path.join( path.dirname(name), path.basename(module.userRequest) );

        info.sourceFilename = sourceFilename;
        info.userRequest = module.userRequest;

        this.assetNames.set(sourceFilename, name);
      }

      return emitFile.call(module, name, content, sourceMap, info);
    };
  }

  /**
   * Add the SRI hash to the assetsInfo map
   *
   * @param {object} compilation
   */
  recordSubresourceIntegrity( compilation )
  {
    const { integrityHashes, integrityPropertyName } = this.options;

    for ( const asset of compilation.getAssets() ) {
      if ( ! asset.info[ integrityPropertyName ] ) {
        asset.info[ integrityPropertyName ] = getSRIHash( integrityHashes, asset.source.source() );

        compilation.assetsInfo.set( asset.name, asset.info );
      }
    }
  }

  /**
   * Hook into the compilation object
   *
   * @param  {object} compilation - the Webpack compilation object
   */
  handleCompilation(compilation)
  {
    ++this[ COMPILATION_COUNTER ];

    NormalModule.getCompilationHooks(compilation).loader.tap(
      PLUGIN_NAME,
      this.handleNormalModuleLoader.bind(this, compilation)
    );

    if ( this.options.integrity ) {
      compilation.hooks.processAssets.tap(
        {
          name: PLUGIN_NAME,
          stage: Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_HASH,
        },
        this.recordSubresourceIntegrity.bind(this, compilation)
      );
    }

    compilation.hooks.processAssets.tap(
      {
        name: PLUGIN_NAME,
        stage: Compilation.PROCESS_ASSETS_STAGE_ANALYSE,
      },
      this.handleProcessAssetsAnalyse.bind(this, compilation)
    );

    compilation.hooks.afterProcessAssets.tap(
      PLUGIN_NAME,
      this.handleAfterProcessAssets.bind(this, compilation)
    );
  }

  /**
   * Determine if webpack-dev-server is being used
   *
   * The WEBPACK_DEV_SERVER env var was added in webpack-dev-server 3.4.1
   *
   * @return {boolean}
   */
  inDevServer()
  {
    return !! process.env.WEBPACK_DEV_SERVER;
  }

  /**
   * Get the file system path to the manifest
   *
   * @return {string} path to manifest file
   */
  getOutputPath()
  {
    if ( path.isAbsolute( this.options.output ) ) {
      return this.options.output;
    }

    if ( ! this.compiler ) {
      return '';
    }

    if ( this.inDevServer() ) {
      let outputPath = get( this, 'compiler.options.devServer.outputPath', get( this, 'compiler.outputPath', '/' ) );

      if ( outputPath === '/' ) {
        warn.once('Please use an absolute path in options.output when using webpack-dev-server.');
        outputPath = get( this, 'compiler.context', process.cwd() );
      }

      return path.resolve( outputPath, this.options.output );
    }

    return path.resolve( this.compiler.outputPath, this.options.output );
  }

  /**
   * Get the public path for the filename
   *
   * @param  {string} filename
   */
  getPublicPath(filename)
  {
    if ( typeof filename === 'string' ) {
      const { publicPath } = this.options;

      if ( typeof publicPath === 'function' ) {
        return publicPath( filename, this );
      }

      if ( typeof publicPath === 'string' ) {
        return url.resolve( publicPath, filename );
      }

      if ( publicPath === true ) {
        return url.resolve(
          get( this, 'compiler.options.output.publicPath', '' ),
          filename
        );
      }
    }

    return filename;
  }

  /**
   * Get a {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy/handler|Proxy} for the manifest.
   * This allows you to use `[]` to manage entries.
   *
   * @param {boolean} raw - Should the proxy use `setRaw` instead of `set`?
   * @return {Proxy}
   */
  getProxy(raw = false)
  {
    const setMethod = raw ? 'setRaw' : 'set';

    const handler = {
      has(target, property) {
        return target.has(property);
      },
      get(target, property) {
        return target.get(property);
      },
      set(target, property, value) {
        return target[ setMethod ](property, value).has(property);
      },
      deleteProperty(target, property) {
        return target.delete(property);
      },
    };

    return new Proxy(this, handler);
  }
}

module.exports = WebpackAssetsManifest;
