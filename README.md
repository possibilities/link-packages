# Link packages [![Build Status](https://travis-ci.org/possibilities/link-packages.svg?branch=master)](https://travis-ci.org/possibilities/link-packages)

Find and `yarn link` local NodeJs packages

## Install

```shell
yarn global add link-packages
```

## Usage

Typically this utility is invoke wherever you keep your NodeJs projects. Any linkable projects found in `process.cwd()` will be symlinked using `yarn link`.

```shell
cd /path/to/your/code
link-packages
```

See `link-packages --help` for full documentation.
