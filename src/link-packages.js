const { join: joinPath } = require('path')
const { readJsonSync, readdirSync, existsSync } = require('fs-extra')
const { spawn } = require('child-process-promise')

// Finds all modules in `process.cwd()` and dredges up the manifest and other
// pertinent metadata.
const findLocalModules = (rootPath, config = {}) => {
  let modulesByName = {}
  const { singlePackage } = config

  readdirSync(rootPath)
    // Resolve the module paths
    .map(modulePath => ({
      path: joinPath(rootPath, modulePath),
      manifestPath: joinPath(rootPath, modulePath, 'package.json')
    }))
    // Filter out non-modules
    .filter(module => existsSync(module.manifestPath))
    // Get the manifest
    .map(module => ({ ...module, manifest: readJsonSync(module.manifestPath) }))
    // In focus mode mark skippable modules
    .map(module => ({
      ...module,
      isSkippable: singlePackage && (singlePackage !== module.manifest.name)
    }))
    // Filter out un-named modules
    .filter(module => module.manifest.name)
    // Filter out modules without dependencies
    .filter(module => module.manifest.dependencies)
    // Find applicable links and add them to the registry
    .forEach(module => {
      const dependencyNames = [
        ...Object.keys(module.manifest.dependencies || {}),
        ...Object.keys(module.manifest.devDependencies || {})
      ]
      if (modulesByName[module.manifest.name]) {
        console.warn('WARNING: Module already found')
        console.warn('  Using module found at:', modulesByName[module.manifest.name].path)
        console.warn('  Ignoring module found at:', module.path)
      } else {
        modulesByName[module.manifest.name] = { ...module, dependencyNames }
      }
    })

  return modulesByName
}

// Checks each provided module for sub-dependencies that are also found in
// provided modules. Returns an object useful for creating yarn links
// between packages. e.g.
const findLocalDependenciesForModules = modulesByName => {
  const moduleNames = Object.keys(modulesByName)
  const modules = moduleNames.map(name => modulesByName[name])

  let dependencies = []
  modules.forEach(({ manifest: { name }, path, isSkippable, dependencyNames }) => {
    const localDeps = dependencyNames.reduce((paths, depName) => {
      if (moduleNames.includes(depName)) {
        const { path: depPath } = modulesByName[depName]
        paths.push({ path: depPath, name: depName })
      }
      return paths
    }, [])

    if (localDeps.length) {
      dependencies.push({ dependencies: localDeps, path, name, isSkippable })
    }
  })

  return dependencies
}

// Helpers for building up command strings and arguments

const buildUnlinkCommandsForLocalDependencies = localDependencies => {
  return localDependencies.reduce((commands, localDependency) => {
    if (localDependency.isSkippable) return commands

    localDependency.dependencies.forEach(dependency => {
      commands.push([`yarn unlink --force`, { cwd: dependency.path }])
    })
    return commands
  }, [])
}

const buildLinkCommandsForLocalDependencies = localDependencies => {
  return localDependencies.reduce((commands, localDependency) => {
    if (localDependency.isSkippable) return commands

    localDependency.dependencies.forEach(dependency => {
      commands.push([`yarn link`, { cwd: dependency.path }])
    })
    return commands
  }, [])
}

const buildLinkCommandsForLocalDependees = localDependencies => {
  return localDependencies.reduce((commands, localDependency) => {
    if (localDependency.isSkippable) return commands

    localDependency.dependencies.forEach(dependency => {
      commands.push([`yarn link ${dependency.name}`, { cwd: localDependency.path }])
    })
    return commands
  }, [])
}

// Turn command strings and arguments into promise returning functions that
// will invoke the command

const buildJobsForLinkCommands = (linkCommands, config = {}) => {
  const handleJobError = error => { if (!config.failSilently) throw error }
  return linkCommands.reduce((jobs, [commandString, options]) => {
    const commandParts = commandString.split(' ')
    const command = commandParts[0]
    const args = commandParts.slice(1)
    const job = () => spawn(command, args, options).catch(handleJobError)
    return [...jobs, job]
  }, [])
}

// Flow control utils

const series = jobs =>
  jobs.reduce((runningJobs, job) => runningJobs.then(job), Promise.resolve())

const parallel = jobs => () => Promise.all(jobs.map(j => j()))

const pipeOutputs = jobs => {
  return jobs.map(job => {
    return () => {
      const running = job()
      running.childProcess.stdout.pipe(process.stdout)
      running.childProcess.stderr.pipe(process.stderr)
      return running
    }
  })
}

// Display utils

const showLinkResults = localDependencies => {
  console.info('Links created')
  localDependencies.forEach(localDependency => {
    if (localDependency.isSkippable) return
    console.info(`* ${localDependency.name} (${localDependency.path})`)
    localDependency.dependencies.forEach(dependency => {
      console.info(`  - ${dependency.name} (${dependency.path})`)
    })
  })
  console.info('Done!')
}

const showErrorAndCrash = error => {
  console.error(error.message)
  console.error('Error linking local packages! Bailing!')
  process.exit(1)
}

// App

const main = config => {
  const { packagesRoot, verbose } = config
  const localModules = findLocalModules(packagesRoot, config)
  const localDependencies = findLocalDependenciesForModules(localModules)

  const unlinkDependencyCommands =
    buildUnlinkCommandsForLocalDependencies(localDependencies, config)
  const linkDependencyCommands =
    buildLinkCommandsForLocalDependencies(localDependencies, config)
  const linkDependeeCommands =
    buildLinkCommandsForLocalDependees(localDependencies, config)

  const unlinkJobs = buildJobsForLinkCommands(
    unlinkDependencyCommands,
    Object.assign({ failSilently: true }, config)
  )

  const linkDependencyJobs = buildJobsForLinkCommands(
    linkDependencyCommands,
    Object.assign({ failSilently: true }, config)
  )

  const linkDependeeJobs = buildJobsForLinkCommands(
    linkDependeeCommands,
    config
  )

  series([
    () => console.info('Unlinking dependencies...'),
    verbose
      ? parallel(pipeOutputs(unlinkJobs))
      : parallel(unlinkJobs),
    () => console.info('Linking dependencies...'),
    verbose
      ? parallel(pipeOutputs(linkDependencyJobs))
      : parallel(linkDependencyJobs),
    () => console.info('Linking dependees...'),
    verbose
      ? parallel(pipeOutputs(linkDependeeJobs))
      : parallel(linkDependeeJobs)
  ])
    .then(() => showLinkResults(localDependencies))
    .catch(showErrorAndCrash)
}

// CLI

const configureApp = require('yargs')

const config = configureApp
  .version()
  .usage('Usage: link-packages [options]')
  .option('packages-root', {
    type: 'string',
    desc: 'Path to packages',
    default: process.cwd()
  })
  .option('single-package', {
    type: 'string',
    desc: 'Link a single dependee by path'
  })
  .option('verbose', {
    type: 'boolean',
    desc: 'Show yarn output',
    default: false
  })
  .help()
  .argv

main(config)
