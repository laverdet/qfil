[![npm version](https://img.shields.io/npm/v/@laverdet/qfil)](https://www.npmjs.com/package/@laverdet/qfil)
[![github action](https://github.com/laverdet/qfil/actions/workflows/build-test-release.yml/badge.svg)](https://github.com/laverdet/qfil/actions/workflows/build-test-release.yml)
[![isc license](https://img.shields.io/npm/l/@laverdet/qfil)](https://github.com/laverdet/qfil/blob/main/LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/@laverdet/qfil)](https://www.npmjs.com/package/@laverdet/qfil)

`qfil` -- `jq`-like filter language in JavaScript
=================================================

This project was created for use in what is essentially a domain-specific content management system. I've got a bunch of
imperfect data archives which need to be queried and converted into structured data. The requirements of queries are
constantly changing but the historic data remains static. A lot of custom transformation functions are required which
aren't nice to implement in jq. Furthermore, the frontend is a nodejs application so embeddability is a requirement.

---

`qfil` is something like `jq` but in JavaScript and with a moddable runtime. As a proof of concept we have a mostly
compatible `jq` runtime, a `js` runtime with JavaScript semantics (as opposed to C-like `jq` semantics), and a bonus
`fs` filesystem runtime.

```
# jq mode
$ qfil -n 'if 0 then "true" else "false" end'
"true"
$ qfil -cn '{} | {a:.a}'
{"a":null}

# js mode
$ qfil -n --runtime js 'if 0 then "true" else "false" end'
"false"
$ qfil -cn --runtime js '{} | {a:.a}'
{}
```

The `fs` runtime exposes the filesystem as a queryable asynchronous graph. This is a minimal proof of concept used to
demonstrate the custom runtime feature. It's not meant as a serious utility, but there's definitely something cool
there which could be fleshed out.

```
$ fq 'add(.. | .size)' /etc/
911902

$ fq 'limit(5; .. | .name)' /usr/bin
"bin"
"["
"activate-global-python-argcomplete"
"apropos"
"apt"
```

---

Speed is not really the point of this project, but it might be faster than plain `jq` anyway:

```
$ time jq -n 'add(limit(10000000; repeat({ value: 1 }) | .value))'
10000000
4.562s

$ time qfil -n 'add(limit(10000000; repeat({ value: 1 }) | .value))'
10000000
3.065s
```

---

`qfil` is meant to be embedded and modded. First pick your base runtime semantics, either `jq` or `js`. Then invoke
`compile` with your filter source and library functions.


Slop Disclosure
===============

This project was largely developed with generative AI, with detailed human scrutiny & technical direction. This is
something I *could have* done without AI but it would have taken months.
