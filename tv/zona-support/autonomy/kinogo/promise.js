'use strict';

// ES5 thenable for Node 0.12 and service runtimes without a global Promise.
// Only this module's small public surface is used by the extractor.
var schedule = typeof setImmediate === 'function' ? setImmediate : function (fn) { setTimeout(fn, 0); };
function PortablePromise(executor) {
    if (!(this instanceof PortablePromise)) { throw new TypeError('Promise requires new'); }
    this._state = 0;
    this._value = undefined;
    this._handlers = [];
    var self = this;
    var called = false;
    function resolve(value) {
        if (called) { return; }
        called = true;
        settle(self, value);
    }
    function reject(reason) {
        if (called) { return; }
        called = true;
        complete(self, 2, reason);
    }
    try { executor(resolve, reject); } catch (error) { reject(error); }
}
function complete(promise, state, value) {
    if (promise._state) { return; }
    promise._state = state;
    promise._value = value;
    var handlers = promise._handlers;
    promise._handlers = [];
    handlers.forEach(function (handler) { dispatch(promise, handler); });
}
function settle(promise, value) {
    if (value === promise) { complete(promise, 2, new TypeError('Promise cycle')); return; }
    if (value && (typeof value === 'object' || typeof value === 'function')) {
        var then;
        try { then = value.then; } catch (error) { complete(promise, 2, error); return; }
        if (typeof then === 'function') {
            var called = false;
            try {
                then.call(value, function (next) {
                    if (!called) { called = true; settle(promise, next); }
                }, function (reason) {
                    if (!called) { called = true; complete(promise, 2, reason); }
                });
            } catch (error) { if (!called) { complete(promise, 2, error); } }
            return;
        }
    }
    complete(promise, 1, value);
}
function dispatch(promise, handler) {
    schedule(function () {
        var fn = promise._state === 1 ? handler.fulfilled : handler.rejected;
        if (typeof fn !== 'function') {
            (promise._state === 1 ? handler.resolve : handler.reject)(promise._value);
            return;
        }
        try { handler.resolve(fn(promise._value)); } catch (error) { handler.reject(error); }
    });
}
PortablePromise.prototype.then = function (fulfilled, rejected) {
    var self = this;
    return new PortablePromise(function (resolve, reject) {
        var handler = {fulfilled: fulfilled, rejected: rejected, resolve: resolve, reject: reject};
        if (self._state) { dispatch(self, handler); } else { self._handlers.push(handler); }
    });
};
PortablePromise.prototype['catch'] = function (rejected) { return this.then(null, rejected); };
PortablePromise.resolve = function (value) { return new PortablePromise(function (resolve) { resolve(value); }); };
PortablePromise.reject = function (reason) { return new PortablePromise(function (_, reject) { reject(reason); }); };
module.exports = PortablePromise;
