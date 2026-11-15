'use strict';
/* ES5/CommonJS portable runtime. Internal generated IR is an ignored artifact.
 * No DEX, Python, Androguard, Android process, account or network at runtime. */
var crypto = require('crypto');
var Long = require('./vendor/long');
var pako = require('./vendor/pako_inflate');
var ir = require('./runtime-ir.json');
var LIMIT = 1024 * 1024;
var TRANSPORT = 'Lmobi/zona/utils/zona;';
function Obj(kind) { this.kind = kind; this.value = null; this.fields = {}; }
function Box(value, bits) { this.value = value; this.bits = bits; }
function long(value) { return Long.isLong(value) ? value : Long.fromNumber(value); }
function text(value) {
  if (value instanceof Obj) { return value.value === null ? '' : String(value.value); }
  if (Long.isLong(value)) { return value.toString(); }
  return String(value);
}
function bytes(value) { return Buffer.isBuffer(value) ? value : new Buffer(value); }
function imul(a, b) { return ((a & 65535) * (b & 65535) + (((a >>> 16) * (b & 65535) + (a & 65535) * (b >>> 16)) << 16)) | 0; }
function truncDiv(a, b) { if (!b) { throw new Error('Division by zero'); } var v = a / b; return v < 0 ? Math.ceil(v) : Math.floor(v); }
function field(ref) { var p = ref.split('->'); return p[0] + '->' + p[1].split(' ')[0]; }
function cloneStatic(value) {
  var out, i;
  if (Array.isArray(value)) { out = []; for (i = 0; i < value.length; i += 1) { out.push(cloneStatic(value[i])); } return out; }
  if (value && value.$object) { out = new Obj(value.$object); out.value = value.value; return out; }
  return value;
}
function utf8(raw) {
  var i = 0, b, n, j, c;
  while (i < raw.length) {
    b = raw[i++];
    if (b < 128) { continue; }
    n = b >= 194 && b <= 223 ? 1 : b >= 224 && b <= 239 ? 2 : b >= 240 && b <= 244 ? 3 : -1;
    if (n < 0 || i + n > raw.length) { throw new Error('Invalid native config UTF-8'); }
    c = raw[i];
    if ((b === 224 && c < 160) || (b === 237 && c > 159) || (b === 240 && c < 144) || (b === 244 && c > 143)) { throw new Error('Invalid native config UTF-8'); }
    for (j = 0; j < n; j += 1) { c = raw[i++]; if (c < 128 || c > 191) { throw new Error('Invalid native config UTF-8'); } }
  }
  return raw.toString('utf8');
}
function gunzip(raw) {
  raw = bytes(raw); if (raw.length > LIMIT) { throw new Error('Compressed config limit exceeded'); }
  var inflate = new pako.Inflate({ windowBits: 31, chunkSize: 16384 });
  var chunks = [], total = 0;
  inflate.onData = function (chunk) { total += chunk.length; if (total > LIMIT) { throw new Error('Decoded config limit exceeded'); } chunks.push(new Buffer(chunk)); };
  inflate.push(raw, true);
  if (inflate.err || !inflate.ended) { throw new Error('Invalid compressed config'); }
  return Buffer.concat(chunks, total);
}
function javaFormat(fmt, args) {
  var next = 0;
  return text(fmt).replace(/%(?:(\d+)\$)?([-#+ 0,(<]*)(\d+)?(?:\.(\d+))?([a-zA-Z%])/g, function (all, position, flags, width, precision, conversion) {
    if (conversion === '%') { return '%'; } if (conversion === 'n') { return '\n'; }
    var index = position ? parseInt(position, 10) - 1 : next++;
    var arg = args[index], bits = arg instanceof Box ? arg.bits : 64, value = arg instanceof Box ? arg.value : arg, result, pad;
    if (conversion.toLowerCase() === 's') { result = text(value); }
    else if (conversion === 'd') { result = text(value); }
    else if (conversion === 'x' || conversion === 'X' || conversion === 'o') {
      result = bits === 32 ? (value >>> 0).toString(conversion === 'o' ? 8 : 16) : long(value).toUnsigned().toString(conversion === 'o' ? 8 : 16);
      if (conversion === 'X') { result = result.toUpperCase(); }
    } else { throw new Error('Unsupported native format'); }
    if (width) { pad = flags.indexOf('0') >= 0 ? '0' : ' '; while (result.length < +width) { result = flags.indexOf('-') >= 0 ? result + pad : pad + result; } }
    return result;
  });
}
function VM(options) {
  options = options || {}; this.options = options; this.methods = {}; this.statics = {}; this.dayCookies = {};
  var i, m, k;
  for (i = 0; i < ir.methods.length; i += 1) { m = ir.methods[i]; this.methods[m.owner + '->' + m.name + m.descriptor] = m; }
  for (k in ir.transportStatics) { if (Object.prototype.hasOwnProperty.call(ir.transportStatics, k)) { this.statics[TRANSPORT + '->' + k] = cloneStatic(ir.transportStatics[k]); } }
  this.run('Llc/d;', '<clinit>', '()V', []);
}
VM.prototype.staticField = function (ref) {
  var key = field(ref), owner = ref.split('->')[0];
  if (Object.prototype.hasOwnProperty.call(this.statics, key)) { return this.statics[key]; }
  if (owner === 'Lkotlin/io/encoding/Base64;') { return new Obj('Base64'); }
  if (owner === 'Ljava/util/Locale;') { return 'ROOT'; }
  throw new Error('Static field outside runtime allowlist');
};
VM.prototype.call = function (ref, args) {
  var split = ref.split('->'), owner = split[0], name = split[1].slice(0, split[1].indexOf('('));
  var desc = split[1].slice(split[1].indexOf('(')).replace(/ /g, ''), obj, value, raw, i, encoded;
  if (owner === TRANSPORT || owner === 'Llc/d;' || owner === 'Llc/b;') { return this.run(owner, name, desc, args); }
  if (owner === 'LNb/a;' && name === 'a') { return 0; }
  if (owner === 'Ljava/lang/Long;' && name === 'valueOf') { return new Box(long(args[0]), 64); }
  if (owner === 'Ljava/lang/Integer;' && name === 'valueOf') { return new Box(args[0] | 0, 32); }
  if (owner === 'Ljava/lang/Long;' && name === 'toString') { return long(args[0]).toString(); }
  if (owner === 'Ljava/lang/Math;' && name === 'abs') { return Math.abs(args[0] | 0) | 0; }
  if (owner === 'Ljava/lang/String;' && name === 'format') { return javaFormat(args[0], args[1]); }
  if (owner === 'Ljava/lang/String;' && name === 'valueOf') { return text(args[0]); }
  if (owner === 'Ljava/util/Random;' && name === '<init>') { return null; }
  if (owner === 'Ljava/util/Random;' && name === 'nextLong') {
    if (this.options.nonceHex !== undefined) { return Long.fromString(this.options.nonceHex, true, 16).toSigned(); }
    raw = crypto.randomBytes(8); return Long.fromBits(raw.readInt32LE(0), raw.readInt32LE(4));
  }
  if (owner === 'Ljava/lang/StringBuilder;') {
    obj = args[0]; if (name === '<init>') { obj.value = ''; return null; }
    if (name === 'append') { obj.value += text(args[1]); return obj; }
    if (name === 'toString') { return text(obj); }
  }
  if (owner === 'Ljava/lang/String;') {
    obj = args[0];
    if (name === '<init>') { value = ''; for (i = 0; i < args[1].length; i += 1) { value += String.fromCharCode(args[1][i] & 65535); } obj.value = value; return null; }
    value = text(obj);
    if (name === 'toCharArray') { raw = []; for (i = 0; i < value.length; i += 1) { raw.push(value.charCodeAt(i)); } return raw; }
    if (name === 'length') { return value.length; }
    if (name === 'charAt') { return value.charCodeAt(args[1]); }
    if (name === 'substring') { return value.substring(args[1], args[2]); }
    if (name === 'toLowerCase') { return value.toLowerCase(); }
  }
  if (owner === 'Lkotlin/text/StringsKt;') {
    if (name === 'concatToString') { value = ''; for (i = 0; i < args[0].length; i += 1) { value += String.fromCharCode(args[0][i] & 65535); } return value; }
    if (name === 'trim') { return args[0].trim(); }
    if (name === 's') { return utf8(bytes(args[0])); }
  }
  if (owner === 'Lkotlin/io/encoding/Base64;' && name === 'decode$default') { return new Buffer(text(args[1]), 'base64'); }
  if (owner === 'Lkotlin/coroutines/intrinsics/IntrinsicsKt;' && name === 'getCOROUTINE_SUSPENDED') { return null; }
  if (owner === 'Lkotlin/ResultKt;' && name === 'throwOnFailure') { return null; }
  if (owner === 'Lkotlin/jvm/internal/Intrinsics;' && name === 'areEqual') { return args[0] === args[1]; }
  if (owner === 'Ljava/lang/Object;' && name === 'toString') { return text(args[0]); }
  if (owner === 'Ljavax/crypto/spec/SecretKeySpec;' && name === '<init>') {
    if (args[2] !== 'AES') { throw new Error('Unsupported config cipher key type'); } args[0].value = bytes(args[1]); return null;
  }
  if (owner === 'Ljavax/crypto/spec/GCMParameterSpec;' && name === '<init>') {
    if (args[1] !== 128 || args[4] !== 12) { throw new Error('Unsupported GCM parameters'); }
    args[0].value = bytes(args[2]).slice(args[3], args[3] + args[4]); return null;
  }
  if (owner === 'Ljavax/crypto/Cipher;') {
    if (name === 'getInstance') { if (args[0] !== 'AES/GCM/NoPadding') { throw new Error('Unsupported config cipher'); } obj = new Obj('Cipher'); obj.value = { aad: new Buffer(0) }; return obj; }
    obj = args[0];
    if (name === 'init') { if (args[1] !== 2) { throw new Error('Config decryption only'); } obj.value.key = args[2].value; obj.value.nonce = args[3].value; return null; }
    if (name === 'updateAAD') { obj.value.aad = Buffer.concat([obj.value.aad, bytes(args[1]).slice(args[2], args[2] + args[3])]); return null; }
    if (name === 'doFinal') {
      value = obj.value; raw = bytes(args[1]).slice(args[2], args[2] + args[3]);
      if (raw.length < 16 || raw.length > LIMIT) { throw new Error('Invalid encrypted config size'); }
      encoded = crypto.createDecipheriv('aes-' + (value.key.length * 8) + '-gcm', value.key, value.nonce);
      encoded.setAuthTag(raw.slice(raw.length - 16)); encoded.setAAD(value.aad);
      return Buffer.concat([encoded.update(raw.slice(0, raw.length - 16)), encoded.final()]);
    }
  }
  if (owner === 'Llc/c;' && name === 'a') { return gunzip(args[0]); }
  if ((owner === 'Ljava/lang/IllegalArgumentException;' || owner === 'Ljava/lang/IllegalStateException;') && name === '<init>') { args[0].value = 'Native config validation rejected input'; return null; }
  throw new Error('External call outside portable allowlist: ' + owner + '->' + name);
};
VM.prototype.run = function (owner, name, descriptor, args) {
  var m = this.methods[owner + '->' + name + descriptor]; if (!m) { throw new Error('Method outside compiled runtime'); }
  var regs = [], at = m.registers - m.inputs, i, index = 0, steps = 0, result = null, ins, op, rr, lit, refs, a, b, n, arr, value, yes, condition, match, action, isLong, vals;
  for (i = 0; i < m.registers; i += 1) { regs[i] = 0; }
  for (i = 0; i < m.types.length; i += 1) { regs[at] = args[i]; at += m.types[i] === 'J' || m.types[i] === 'D' ? 2 : 1; }
  while (index < m.instructions.length) {
    steps += 1; if (steps > 3000000) { throw new Error('Portable instruction limit exceeded'); }
    ins = m.instructions[index++]; op = ins[0]; rr = ins[1]; lit = ins[2]; refs = ins[3];
    if (op === 'return-void') { return null; }
    if (op.indexOf('return') === 0) { return regs[rr[0]]; }
    if (op.indexOf('move-result') === 0) { regs[rr[0]] = result; continue; }
    if (op.indexOf('move') === 0) { regs[rr[0]] = regs[rr[1]]; continue; }
    if (op.indexOf('const-string') === 0) { regs[rr[0]] = refs[refs.length - 1]; continue; }
    if (op.indexOf('const') === 0) { regs[rr[0]] = op.indexOf('const-wide') === 0 ? Long.fromString(lit[0]) : lit[0] | 0; continue; }
    if (op.indexOf('sget') === 0) { regs[rr[0]] = this.staticField(refs[refs.length - 1]); continue; }
    if (op.indexOf('sput') === 0) { this.statics[field(refs[refs.length - 1])] = regs[rr[0]]; continue; }
    if (op.indexOf('iget') === 0) { regs[rr[0]] = regs[rr[1]].fields[refs[refs.length - 1].split('->')[1].split(' ')[0]]; continue; }
    if (op === 'new-array') { n = regs[rr[1]]; if (typeof n !== 'number' || n < 0 || n > LIMIT) { throw new Error('Portable array limit exceeded'); } arr = []; for (i = 0; i < n; i += 1) { arr.push(0); } regs[rr[0]] = arr; continue; }
    if (op === 'filled-new-array') { result = []; for (i = 0; i < rr.length; i += 1) { result.push(regs[rr[i]]); } continue; }
    if (op.indexOf('aget') === 0) { arr = regs[rr[1]]; n = regs[rr[2]]; if (n < 0 || n >= arr.length) { throw new Error('Native table index outside published data'); } regs[rr[0]] = arr[n]; continue; }
    if (op.indexOf('aput') === 0) { arr = regs[rr[1]]; n = regs[rr[2]]; if (n < 0 || n >= arr.length) { throw new Error('Native array index invalid'); } arr[n] = regs[rr[0]]; continue; }
    if (op === 'array-length') { regs[rr[0]] = regs[rr[1]].length; continue; }
    if (op === 'new-instance') { regs[rr[0]] = new Obj(refs[refs.length - 1]); continue; }
    if (op.indexOf('invoke') === 0) { vals = []; for (i = 0; i < ins[5].length; i += 1) { vals.push(regs[ins[5][i]]); } result = this.call(refs[refs.length - 1], vals); continue; }
    if (op.indexOf('if-') === 0) {
      a = regs[rr[0]]; b = rr.length > 1 ? regs[rr[1]] : 0; a = a === null ? 0 : typeof a === 'boolean' ? (a ? 1 : 0) : a; b = b === null ? 0 : typeof b === 'boolean' ? (b ? 1 : 0) : b; condition = op.slice(3).replace(/z/g, '');
      if (Long.isLong(a) || Long.isLong(b)) { n = long(a).compare(long(b)); yes = condition === 'eq' ? n === 0 : condition === 'ne' ? n !== 0 : condition === 'lt' ? n < 0 : condition === 'le' ? n <= 0 : condition === 'gt' ? n > 0 : n >= 0; }
      else { yes = condition === 'eq' ? a === b : condition === 'ne' ? a !== b : condition === 'lt' ? a < b : condition === 'le' ? a <= b : condition === 'gt' ? a > b : a >= b; }
      if (yes) { index = ins[4]; } continue;
    }
    if (op.indexOf('goto') === 0) { index = ins[4]; continue; }
    if (op === 'int-to-long') { regs[rr[0]] = Long.fromInt(regs[rr[1]]); continue; }
    if (op === 'long-to-int') { regs[rr[0]] = long(regs[rr[1]]).toInt(); continue; }
    if (op === 'int-to-char') { regs[rr[0]] = regs[rr[1]] & 65535; continue; }
    if (op.indexOf('neg-') === 0 || op.indexOf('not-') === 0) { a = regs[rr[1]]; regs[rr[0]] = op.indexOf('long') >= 0 ? op.indexOf('neg-') === 0 ? long(a).negate() : long(a).not() : op.indexOf('neg-') === 0 ? -a | 0 : ~a; continue; }
    if (op === 'throw') { throw new Error('Original config decoder rejected input'); }
    match = /^(add|sub|rsub|mul|div|rem|and|or|xor|shl|shr|ushr)-(int|long)/.exec(op);
    if (match) {
      action = match[1]; isLong = match[2] === 'long'; a = op.indexOf('/2addr') >= 0 ? regs[rr[0]] : regs[rr[1]];
      b = op.indexOf('/lit') >= 0 ? lit[0] : op.indexOf('/2addr') >= 0 ? regs[rr[1]] : regs[rr[2]];
      if (isLong) {
        a = long(a); b = long(b);
        if (action === 'add') { value = a.add(b); } else if (action === 'sub') { value = a.subtract(b); } else if (action === 'rsub') { value = b.subtract(a); } else if (action === 'mul') { value = a.multiply(b); } else if (action === 'div') { value = a.divide(b); } else if (action === 'rem') { value = a.modulo(b); } else if (action === 'and') { value = a.and(b); } else if (action === 'or') { value = a.or(b); } else if (action === 'xor') { value = a.xor(b); } else if (action === 'shl') { value = a.shiftLeft(b.toInt() & 63); } else if (action === 'shr') { value = a.shiftRight(b.toInt() & 63); } else { value = a.shiftRightUnsigned(b.toInt() & 63); }
      } else {
        if (action === 'add') { value = a + b; } else if (action === 'sub') { value = a - b; } else if (action === 'rsub') { value = b - a; } else if (action === 'mul') { value = imul(a, b); } else if (action === 'div') { value = truncDiv(a, b); } else if (action === 'rem') { value = a - truncDiv(a, b) * b; } else if (action === 'and') { value = a & b; } else if (action === 'or') { value = a | b; } else if (action === 'xor') { value = a ^ b; } else if (action === 'shl') { value = a << (b & 31); } else if (action === 'shr') { value = a >> (b & 31); } else { value = a >>> (b & 31); }
        value = value | 0;
      }
      regs[rr[0]] = value; continue;
    }
    throw new Error('Unsupported compiled opcode');
  }
  throw new Error('Native body returned no value');
};
function createRuntime(options) {
  var vm = new VM(options || {});
  return {
    makeTransport: function (epochMs, ua) {
      if (typeof epochMs !== 'number' || !isFinite(epochMs) || Math.floor(epochMs) !== epochMs || Math.abs(epochMs) > 9007199254740991 || typeof ua !== 'string' || ua.length > 4096) { throw new Error('Invalid anonymous transport input'); }
      var clientTime = text(vm.run(TRANSPORT, 'checkTimeNative123', '(Landroid/content/Context;JLjava/lang/String;)Ljava/lang/String;', [null, Long.fromNumber(epochMs), ua]));
      var prefix = parseInt(clientTime.split('.')[0], 10), day = Math.floor(prefix / 86400000), key = String(day);
      if (!Object.prototype.hasOwnProperty.call(vm.dayCookies, key)) { vm.dayCookies[key] = text(vm.run(TRANSPORT, 'Cookie', '(Landroid/content/Context;J)Ljava/lang/String;', [null, Long.fromNumber(prefix)])); }
      var days = Object.keys(vm.dayCookies).sort(function (a,b) { return Number(a)-Number(b); });
      while (days.length > 8) { delete vm.dayCookies[days.shift()]; }
      return { client_time: clientTime, cookie: 's=' + vm.dayCookies[key] };
    },
    decodeConfig: function (raw, encoding) {
      if (!Buffer.isBuffer(raw)) { throw new Error('Expected config Buffer'); } if (!raw.length || raw.length > LIMIT) { throw new Error('Config input limit exceeded'); }
      var obj = new Obj('Llc/b;'); obj.fields = { j: raw, k: encoding === undefined ? null : encoding };
      var value = JSON.parse(vm.run('Llc/b;', 'invokeSuspend', '(Ljava/lang/Object;)Ljava/lang/Object;', [obj, null]));
      if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error('Expected config JSON object'); }
      return value;
    },
    encodeParams: function (payload) {
      var raw = new Buffer(JSON.stringify(payload), 'utf8'); if (raw.length > LIMIT) { throw new Error('Params limit exceeded'); }
      var salt = options && options.salt ? bytes(options.salt) : crypto.randomBytes(8), out = new Buffer(1 + salt.length + raw.length), i;
      if (salt.length !== 8) { throw new Error('Expected native eight-byte salt'); }
      out[0] = salt.length; salt.copy(out, 1);
      for (i = 0; i < raw.length; i += 1) { out[1 + salt.length + i] = (raw[i] + salt[i % salt.length] + 4 * i + 17) & 255; }
      return out.toString('base64');
    }
  };
}
var shared;
function runtime() { if (!shared) { shared = createRuntime(); } return shared; }
exports.makeTransport = function (epochMs, ua) { return runtime().makeTransport(epochMs, ua); };
exports.decodeConfig = function (raw, encoding) { return runtime().decodeConfig(raw, encoding); };
exports.encodeParams = function (payload) { return runtime().encodeParams(payload); };
exports.createRuntime = createRuntime;
