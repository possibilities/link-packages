# Link packages

Find and `yarn link` local NodeJs packages

## Install

```shell
yarn global add link-packages
```

## Usage

Typically this utility is invoke wherever you keep your NodeJs projects. Any linkable projects found in `process.cwd()` will be symlinked using `yarn link`.

```shell
link-packages
```

## Development

```shell
yarn dev
```
