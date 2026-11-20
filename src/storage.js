'use strict';
const { validRecord, normalize } = require('./core');
const KEY = 'codeReviewed.state.v1';
class ReviewStore {
  constructor(memento, onError = () => {}, portable) {
    this.portable = portable;
    this.memento = memento;
    this.onError = onError;
    this.files = new Map();
    this.ignored = new Set();
    const saved = memento.get(KEY);
    if ([1, 2].includes(saved?.version) && Array.isArray(saved.files)) {
      for (const entry of saved.files) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && validRecord(entry[1])) this.files.set(entry[0], normalize(entry[1]));
      }
    }
    if (Array.isArray(saved?.ignored)) for (const key of saved.ignored) if (typeof key === 'string') this.ignored.add(key);
    this.pending = Promise.resolve();
  }
  save() {
    // Capture now and serialize writes so a slower earlier save cannot win.
    const snapshot = JSON.parse(JSON.stringify({ version: 2, files: [...this.files], ignored: [...this.ignored] }));
    const operation = this.pending.then(async () => {
      await this.memento.update(KEY, snapshot);
      if (this.portable) await this.portable.save(new Map(snapshot.files), new Set(snapshot.ignored));
    });
    this.pending = operation.catch(error => this.onError(error));
    return operation;
  }
  rename(oldUri, newUri) {
    for (const key of [...this.ignored]) if (key === oldUri || key.startsWith(oldUri + '/')) {
      this.ignored.delete(key); this.ignored.add(newUri + key.slice(oldUri.length));
    }
    for (const [key, record] of [...this.files]) {
      if (key === oldUri || key.startsWith(oldUri + '/')) {
        this.files.delete(key);
        this.files.set(newUri + key.slice(oldUri.length), record);
      }
    }
  }
  remove(uri) {
    for (const key of this.files.keys()) if (key === uri || key.startsWith(uri + '/')) this.files.delete(key);
  }
}
module.exports = { ReviewStore };
