

function dbCleanupOldDocs(db: PouchDB.Database, cacheMaxAge: number): Promise<any> {
	return db.allDocs({include_docs: true}).then(allDocs => {
		const toBeRemoved: any[] = [];
		const now = Date.now();
		allDocs.rows.forEach(row => {
			if (now > (row.doc as any).timestamp + cacheMaxAge) {
				// Tile is too old - add to cleanup
				toBeRemoved.push({_id: row.id, _rev: row.doc._rev, _deleted: true});
			}
		});
		return toBeRemoved;
	}).then(deleteDocs => {
		console.log('cleanup docs number:', deleteDocs.length);
		return db.bulkDocs(deleteDocs).then(() => {
			return db.compact();
		});
	});
}

export function dbCleanupOnLimit(db: PouchDB.Database, cleanTriggerLimit: number, cacheMaxAge: number): Promise<any> {
	return db.info().then((res: any) => {
		console.log('info.doc_count:', res.doc_count);
		if (res.doc_count > cleanTriggerLimit) {
			return dbCleanupOldDocs(db, cacheMaxAge);
		}
	}).catch((err) => {
		console.log(err);
	});
}
