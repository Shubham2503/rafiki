import { EventEmitter } from 'events'
import createLogger from 'pino'
import Knex from 'knex'
import { Model } from 'objection'
import { makeWorkerUtils } from 'graphile-worker'
import { Ioc, IocContract } from '@adonisjs/fold'
import IORedis from 'ioredis'

import { App, AppServices } from './app'
import { Config } from './config/app'
import { GraphileProducer } from './infrastructure/graphileProducer'

const container = initIocContainer(Config)
const app = new App(container)

export function initIocContainer(
  config: typeof Config
): IocContract<AppServices> {
  const container: IocContract<AppServices> = new Ioc()
  container.singleton('config', async () => config)
  container.singleton('workerUtils', async (deps: IocContract<AppServices>) => {
    const config = await deps.use('config')
    const logger = await deps.use('logger')
    logger.info({ msg: 'creating graphile worker utils' })
    const workerUtils = await makeWorkerUtils({
      connectionString: config.databaseUrl
    })
    await workerUtils.migrate()
    return workerUtils
  })
  container.singleton('logger', async (deps: IocContract<AppServices>) => {
    const config = await deps.use('config')
    const logger = createLogger()
    logger.level = config.logLevel
    return logger
  })
  container.singleton(
    'messageProducer',
    async (deps: IocContract<AppServices>) => {
      const logger = await deps.use('logger')
      const workerUtils = await deps.use('workerUtils')
      logger.info({ msg: 'creating graphile producer' })
      return new GraphileProducer(workerUtils)
    }
  )
  container.singleton('knex', async (deps: IocContract<AppServices>) => {
    const logger = await deps.use('logger')
    const config = await deps.use('config')
    logger.info({ msg: 'creating knex' })
    const knex = Knex({
      client: 'postgresql',
      connection: config.databaseUrl,
      pool: {
        min: 2,
        max: 10
      },
      migrations: {
        tableName: 'knex_migrations'
      }
    })
    // node pg defaults to returning bigint as string. This ensures it parses to bigint
    knex.client.driver.types.setTypeParser(20, 'text', BigInt)
    return knex
  })
  container.singleton('closeEmitter', async () => new EventEmitter())
  container.singleton('redis', async (deps) => {
    const config = await deps.use('config')
    return new IORedis(config.redisUrl)
  })

  return container
}

export const gracefulShutdown = async (
  container: IocContract<AppServices>,
  app: App
): Promise<void> => {
  const logger = await container.use('logger')
  logger.info('shutting down.')
  await app.shutdown()
  const knex = await container.use('knex')
  await knex.destroy()
  const workerUtils = await container.use('workerUtils')
  await workerUtils.release()
  const redis = await container.use('redis')
  await redis.disconnect()
}

export const start = async (
  container: IocContract<AppServices>,
  app: App
): Promise<void> => {
  let shuttingDown = false
  const logger = await container.use('logger')
  process.on(
    'SIGINT',
    async (): Promise<void> => {
      logger.info('received SIGINT attempting graceful shutdown')
      try {
        if (shuttingDown) {
          logger.warn(
            'received second SIGINT during graceful shutdown, exiting forcefully.'
          )
          process.exit(1)
        }

        shuttingDown = true

        // Graceful shutdown
        await gracefulShutdown(container, app)
        logger.info('completed graceful shutdown.')
        process.exit(0)
      } catch (err) {
        const errInfo =
          err && typeof err === 'object' && err.stack ? err.stack : err
        logger.error({ error: errInfo }, 'error while shutting down')
        process.exit(1)
      }
    }
  )

  process.on(
    'SIGTERM',
    async (): Promise<void> => {
      logger.info('received SIGTERM attempting graceful shutdown')

      try {
        // Graceful shutdown
        await gracefulShutdown(container, app)
        logger.info('completed graceful shutdown.')
        process.exit(0)
      } catch (err) {
        const errInfo =
          err && typeof err === 'object' && err.stack ? err.stack : err
        logger.error({ error: errInfo }, 'error while shutting down')
        process.exit(1)
      }
    }
  )

  // Do migrations
  const knex = await container.use('knex')
  await knex.migrate.latest().catch((error): void => {
    logger.error({ error }, 'error migrating database')
  })

  Model.knex(knex)

  const config = await container.use('config')
  await app.boot()
  app.listen(config.port)
  logger.info(`Listening on ${app.getPort()}`)
}

// If this script is run directly, start the server
if (!module.parent) {
  start(container, app).catch(
    async (e): Promise<void> => {
      const errInfo = e && typeof e === 'object' && e.stack ? e.stack : e
      const logger = await container.use('logger')
      logger.error(errInfo)
    }
  )
}