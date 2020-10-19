import('./hello.js').then( module => console.log( module ) );
import(/* webpackChunkName: "load-styles" */ './load-styles.js').then( module => console.log( module ) );

console.log('Complex');
