
/* tslint:disable: no-invalid-this */
import * as L from 'leaflet';
import PouchDB from 'pouchdb';
import * as pouchdb_upsert from 'pouchdb-upsert';
PouchDB.plugin(pouchdb_upsert);
import { dbCleanupOnLimit } from './pouchdb-utils';

// some types
interface TileCoords {
	x: number;
	y: number;
	z: number;
}

interface CachedTileLayer extends L.TileLayer {
	_db: PouchDB.Database;
	_canvas: HTMLCanvasElement;
	_checkLimitCounter: number;

	_onCacheLookup(tile: any, tileUrl: string, done: any): any;
	_saveTile(tile: any, tileUrl: string, existingRevision: any, done: any): void;

	// L.TileLayer missing methods
	_tileOnLoad(done: any, tile: any): void;
	_tileOnError(done: any, tile: any, e: any): void;
	getTileUrl(coords: TileCoords): string;
}

// some types - end

const CHECK_LIMIT_COUNTER = 100;
const MAX_DOCS_COUNT = 200;

function returnDoneIfDefined(done: () => void): void {
	if (done) {
		return done();
	}
	return;
}


L.TileLayer.addInitHook(function(this: CachedTileLayer) {
	this._checkLimitCounter = CHECK_LIMIT_COUNTER;
	if (!this.options.useCache) {
		this._db = null;
		this._canvas = null;
		return;
	}
	if (this.options.dbOptions) {
		this._db = new PouchDB('offline-tiles', this.options.dbOptions);
	} else {
		this._db = new PouchDB('offline-tiles');
	}
	this._canvas = document.createElement('canvas');
	if (!(this._canvas.getContext && this._canvas.getContext('2d'))) {
			// HTML5 canvas is needed to pack the tiles as base64 data. If
			//   the browser doesn't support canvas, the code will forcefully
			//   skip caching the tiles.
			this._canvas = null;
		}
});

// 🍂namespace TileLayer
// 🍂section PouchDB tile caching options
// 🍂option useCache: Boolean = false
// Whether to use a PouchDB cache on this tile layer, or not
L.TileLayer.prototype.options.useCache = false;

// 🍂option saveToCache: Boolean = true
// When caching is enabled, whether to save new tiles to the cache or not
L.TileLayer.prototype.options.saveToCache  = true;

// 🍂option useOnlyCache: Boolean = false
// When caching is enabled, whether to request new tiles from the network or not
L.TileLayer.prototype.options.useOnlyCache = false;

// 🍂option useCache: String = 'image/png'
// The image format to be used when saving the tile images in the cache
L.TileLayer.prototype.options.cacheFormat = 'image/png';

// 🍂option cacheMaxAge: Number = 24 * 3600 * 1000
// Maximum age of the cache, in milliseconds
L.TileLayer.prototype.options.cacheMaxAge  = 24 * 3600 * 1000;

// Size limit for the DB in MB, (assuming a 12 Ko weight for a single tile)
L.TileLayer.prototype.options.dbSizeLimit  = 40; // in Mb


L.TileLayer.include({

	// Overwrites L.TileLayer.prototype.createTile
	createTile(this: CachedTileLayer, coords: TileCoords, done: () => void) {
		const tile = document.createElement('img');

		tile.onerror = L.Util.bind((this._tileOnError as any), this, done, tile);

		if (this.options.crossOrigin) {
			tile.crossOrigin = '';
		}

		/*
			Alt tag is *set to empty string to keep screen readers from reading URL and for compliance reasons
			http://www.w3.org/TR/WCAG20-TECHS/H67
			*/
		tile.alt = '';

		const tileUrl = this.getTileUrl(coords);

		if (this.options.useCache && this._canvas) {
			// TODO - can I remove: revs_info: true here?
			this._db.get(tileUrl, {revs_info: true}, this._onCacheLookup(tile, tileUrl, done));
		} else {
			// Fall back to standard behaviour
			tile.onload = L.Util.bind((this._tileOnLoad as any), this, done, tile);
		}

		tile.src = tileUrl;
		return tile;
	},

	// Returns a callback (closure over tile/key/originalSrc) to be run when the DB
	//   backend is finished with a fetch operation.
	_onCacheLookup(this: CachedTileLayer, tile: HTMLImageElement, tileUrl: string, done: () => void) {
		return (_err: any, data: any) => {
			if (data) {
				this.fire('tilecachehit', {
					tile,
					url: tileUrl
				});
				if (Date.now() > data.timestamp + this.options.cacheMaxAge && !this.options.useOnlyCache) {
					// Tile is too old, try to refresh it
					console.log('Tile is too old: ', tileUrl);

					if (this.options.saveToCache) {
						tile.onload = L.Util.bind((this._saveTile as any), this, tile, tileUrl, false, done);
					}
					tile.crossOrigin = 'Anonymous';
					tile.src = tileUrl;
					tile.onerror = function(_ev: any) {
						// If the tile is too old but couldn't be fetched from the network,
						//   serve the one still in cache.
						(this as HTMLImageElement).src = data.dataUrl;
					};
				} else {
					// Serve tile from cached data
					// console.log('Tile is cached: ', tileUrl);
					tile.onload = L.Util.bind((this._tileOnLoad as any), this, done, tile);
					tile.src = data.dataUrl;    // data.dataUrl is already a base64-encoded PNG image.
				}
			} else {
				this.fire('tilecachemiss', {
					tile,
					url: tileUrl
				});
				if (this.options.useOnlyCache) {
					// Offline, not cached
					// console.log('Tile not in cache', tileUrl);
					tile.onload = L.Util.falseFn;
					tile.src = L.Util.emptyImageUrl;
				} else {
					//Online, not cached, request the tile normally
					// console.log('Requesting tile normally', tileUrl);
					if (this.options.saveToCache) {
						tile.onload = L.Util.bind((this._saveTile as any), this, tile, tileUrl, null, done);
					} else {
						tile.onload = L.Util.bind((this._tileOnLoad as any), this, done, tile);
					}
					tile.crossOrigin = 'Anonymous';
					tile.src = tileUrl;
				}
			}
		};
	},

	// Returns an event handler (closure over DB key), which runs
	//   when the tile (which is an <img>) is ready.
	// The handler will delete the document from pouchDB if an existing revision is passed.
	//   This will keep just the latest valid copy of the image in the cache.
	_saveTile(this: CachedTileLayer, tile: any, tileUrl: string, _existingRevision: any, done: () => void) {
		if (this._canvas === null) {
			return;
		}
		this._canvas.width  = tile.naturalWidth  || tile.width;
		this._canvas.height = tile.naturalHeight || tile.height;

		const context = this._canvas.getContext('2d');
		context.drawImage(tile, 0, 0);

		let dataUrl: string;
		try {
			dataUrl = this._canvas.toDataURL(this.options.cacheFormat);
		} catch (error) {
			this.fire('tilecacheerror', { tile, error });
			return returnDoneIfDefined(done);
		}
		this._db.upsert(tileUrl, (doc: any) => {
			if (!doc.dataUrl) {
				doc.dataUrl = dataUrl;
			}
			doc.timestamp = Date.now();
			return doc;
		}).then(_res => {
			// success, res is {rev: '1-xxx', updated: true, id: 'myDocId'}
		}).catch(err => {
			console.error('err on upsert', err);
		});

		// run cleanup once in a while
		if (this._checkLimitCounter === 0) {
			dbCleanupOnLimit(this._db, MAX_DOCS_COUNT, this.options.cacheMaxAge);
			this._checkLimitCounter = CHECK_LIMIT_COUNTER;
		}
		this._checkLimitCounter--;

		return returnDoneIfDefined(done);

	}
});
