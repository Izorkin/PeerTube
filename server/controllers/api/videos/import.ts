import * as express from 'express'
import { move, readFile } from 'fs-extra'
import * as magnetUtil from 'magnet-uri'
import * as parseTorrent from 'parse-torrent'
import { join } from 'path'
import { getEnabledResolutions } from '@server/lib/config'
import { setVideoTags } from '@server/lib/video'
import { FilteredModelAttributes } from '@server/types'
import {
  MChannelAccountDefault,
  MThumbnail,
  MUser,
  MVideoAccountDefault,
  MVideoCaption,
  MVideoTag,
  MVideoThumbnail,
  MVideoWithBlacklistLight
} from '@server/types/models'
import { MVideoImportFormattable } from '@server/types/models/video/video-import'
import { ServerErrorCode, VideoImportCreate, VideoImportState, VideoPrivacy, VideoState } from '../../../../shared'
import { HttpStatusCode } from '../../../../shared/core-utils/miscs/http-error-codes'
import { ThumbnailType } from '../../../../shared/models/videos/thumbnail.type'
import { auditLoggerFactory, getAuditIdFromRes, VideoImportAuditView } from '../../../helpers/audit-logger'
import { moveAndProcessCaptionFile } from '../../../helpers/captions-utils'
import { isArray } from '../../../helpers/custom-validators/misc'
import { cleanUpReqFiles, createReqFiles } from '../../../helpers/express-utils'
import { logger } from '../../../helpers/logger'
import { getSecureTorrentName } from '../../../helpers/utils'
import { YoutubeDL, YoutubeDLInfo } from '../../../helpers/youtube-dl'
import { CONFIG } from '../../../initializers/config'
import { MIMETYPES } from '../../../initializers/constants'
import { sequelizeTypescript } from '../../../initializers/database'
import { getLocalVideoActivityPubUrl } from '../../../lib/activitypub/url'
import { JobQueue } from '../../../lib/job-queue/job-queue'
import { createVideoMiniatureFromExisting, createVideoMiniatureFromUrl } from '../../../lib/thumbnail'
import { autoBlacklistVideoIfNeeded } from '../../../lib/video-blacklist'
import { asyncMiddleware, asyncRetryTransactionMiddleware, authenticate, videoImportAddValidator } from '../../../middlewares'
import { VideoModel } from '../../../models/video/video'
import { VideoCaptionModel } from '../../../models/video/video-caption'
import { VideoImportModel } from '../../../models/video/video-import'

const auditLogger = auditLoggerFactory('video-imports')
const videoImportsRouter = express.Router()

const reqVideoFileImport = createReqFiles(
  [ 'thumbnailfile', 'previewfile', 'torrentfile' ],
  Object.assign({}, MIMETYPES.TORRENT.MIMETYPE_EXT, MIMETYPES.IMAGE.MIMETYPE_EXT),
  {
    thumbnailfile: CONFIG.STORAGE.TMP_DIR,
    previewfile: CONFIG.STORAGE.TMP_DIR,
    torrentfile: CONFIG.STORAGE.TMP_DIR
  }
)

videoImportsRouter.post('/imports',
  authenticate,
  reqVideoFileImport,
  asyncMiddleware(videoImportAddValidator),
  asyncRetryTransactionMiddleware(addVideoImport)
)

// ---------------------------------------------------------------------------

export {
  videoImportsRouter
}

// ---------------------------------------------------------------------------

function addVideoImport (req: express.Request, res: express.Response) {
  if (req.body.targetUrl) return addYoutubeDLImport(req, res)

  const file = req.files?.['torrentfile']?.[0]
  if (req.body.magnetUri || file) return addTorrentImport(req, res, file)
}

async function addTorrentImport (req: express.Request, res: express.Response, torrentfile: Express.Multer.File) {
  const body: VideoImportCreate = req.body
  const user = res.locals.oauth.token.User

  let videoName: string
  let torrentName: string
  let magnetUri: string

  if (torrentfile) {
    torrentName = torrentfile.originalname

    // Rename the torrent to a secured name
    const newTorrentPath = join(CONFIG.STORAGE.TORRENTS_DIR, getSecureTorrentName(torrentName))
    await move(torrentfile.path, newTorrentPath, { overwrite: true })
    torrentfile.path = newTorrentPath

    const buf = await readFile(torrentfile.path)
    const parsedTorrent = parseTorrent(buf) as parseTorrent.Instance

    if (parsedTorrent.files.length !== 1) {
      cleanUpReqFiles(req)

      return res.status(HttpStatusCode.BAD_REQUEST_400)
        .json({
          code: ServerErrorCode.INCORRECT_FILES_IN_TORRENT,
          error: 'Torrents with only 1 file are supported.'
        })
    }

    videoName = isArray(parsedTorrent.name) ? parsedTorrent.name[0] : parsedTorrent.name
  } else {
    magnetUri = body.magnetUri

    const parsed = magnetUtil.decode(magnetUri)
    videoName = isArray(parsed.name) ? parsed.name[0] : parsed.name as string
  }

  const video = buildVideo(res.locals.videoChannel.id, body, { name: videoName })

  const thumbnailModel = await processThumbnail(req, video)
  const previewModel = await processPreview(req, video)

  const tags = body.tags || undefined
  const videoImportAttributes = {
    magnetUri,
    torrentName,
    state: VideoImportState.PENDING,
    userId: user.id
  }
  const videoImport = await insertIntoDB({
    video,
    thumbnailModel,
    previewModel,
    videoChannel: res.locals.videoChannel,
    tags,
    videoImportAttributes,
    user
  })

  // Create job to import the video
  const payload = {
    type: torrentfile ? 'torrent-file' as 'torrent-file' : 'magnet-uri' as 'magnet-uri',
    videoImportId: videoImport.id,
    magnetUri
  }
  await JobQueue.Instance.createJobWithPromise({ type: 'video-import', payload })

  auditLogger.create(getAuditIdFromRes(res), new VideoImportAuditView(videoImport.toFormattedJSON()))

  return res.json(videoImport.toFormattedJSON()).end()
}

async function addYoutubeDLImport (req: express.Request, res: express.Response) {
  const body: VideoImportCreate = req.body
  const targetUrl = body.targetUrl
  const user = res.locals.oauth.token.User

  const youtubeDL = new YoutubeDL(targetUrl, getEnabledResolutions('vod'))

  // Get video infos
  let youtubeDLInfo: YoutubeDLInfo
  try {
    youtubeDLInfo = await youtubeDL.getYoutubeDLInfo()
  } catch (err) {
    logger.info('Cannot fetch information from import for URL %s.', targetUrl, { err })

    return res.status(HttpStatusCode.BAD_REQUEST_400)
              .json({
                error: 'Cannot fetch remote information of this URL.'
              })
  }

  const video = buildVideo(res.locals.videoChannel.id, body, youtubeDLInfo)

  // Process video thumbnail from request.files
  let thumbnailModel = await processThumbnail(req, video)

  // Process video thumbnail from url if processing from request.files failed
  if (!thumbnailModel && youtubeDLInfo.thumbnailUrl) {
    thumbnailModel = await processThumbnailFromUrl(youtubeDLInfo.thumbnailUrl, video)
  }

  // Process video preview from request.files
  let previewModel = await processPreview(req, video)

  // Process video preview from url if processing from request.files failed
  if (!previewModel && youtubeDLInfo.thumbnailUrl) {
    previewModel = await processPreviewFromUrl(youtubeDLInfo.thumbnailUrl, video)
  }

  const tags = body.tags || youtubeDLInfo.tags
  const videoImportAttributes = {
    targetUrl,
    state: VideoImportState.PENDING,
    userId: user.id
  }
  const videoImport = await insertIntoDB({
    video,
    thumbnailModel,
    previewModel,
    videoChannel: res.locals.videoChannel,
    tags,
    videoImportAttributes,
    user
  })

  // Get video subtitles
  try {
    const subtitles = await youtubeDL.getYoutubeDLSubs()

    logger.info('Will create %s subtitles from youtube import %s.', subtitles.length, targetUrl)

    for (const subtitle of subtitles) {
      const videoCaption = new VideoCaptionModel({
        videoId: video.id,
        language: subtitle.language,
        filename: VideoCaptionModel.generateCaptionName(subtitle.language)
      }) as MVideoCaption

      // Move physical file
      await moveAndProcessCaptionFile(subtitle, videoCaption)

      await sequelizeTypescript.transaction(async t => {
        await VideoCaptionModel.insertOrReplaceLanguage(videoCaption, t)
      })
    }
  } catch (err) {
    logger.warn('Cannot get video subtitles.', { err })
  }

  // Create job to import the video
  const payload = {
    type: 'youtube-dl' as 'youtube-dl',
    videoImportId: videoImport.id,
    fileExt: `.${youtubeDLInfo.ext || 'mp4'}`
  }
  await JobQueue.Instance.createJobWithPromise({ type: 'video-import', payload })

  auditLogger.create(getAuditIdFromRes(res), new VideoImportAuditView(videoImport.toFormattedJSON()))

  return res.json(videoImport.toFormattedJSON()).end()
}

function buildVideo (channelId: number, body: VideoImportCreate, importData: YoutubeDLInfo): MVideoThumbnail {
  const videoData = {
    name: body.name || importData.name || 'Unknown name',
    remote: false,
    category: body.category || importData.category,
    licence: body.licence || importData.licence,
    language: body.language || importData.language,
    commentsEnabled: body.commentsEnabled !== false, // If the value is not "false", the default is "true"
    downloadEnabled: body.downloadEnabled !== false,
    waitTranscoding: body.waitTranscoding || false,
    state: VideoState.TO_IMPORT,
    nsfw: body.nsfw || importData.nsfw || false,
    description: body.description || importData.description,
    support: body.support || null,
    privacy: body.privacy || VideoPrivacy.PRIVATE,
    duration: 0, // duration will be set by the import job
    channelId: channelId,
    originallyPublishedAt: body.originallyPublishedAt
      ? new Date(body.originallyPublishedAt)
      : importData.originallyPublishedAt
  }
  const video = new VideoModel(videoData)
  video.url = getLocalVideoActivityPubUrl(video)

  return video
}

async function processThumbnail (req: express.Request, video: MVideoThumbnail) {
  const thumbnailField = req.files ? req.files['thumbnailfile'] : undefined
  if (thumbnailField) {
    const thumbnailPhysicalFile = thumbnailField[0]

    return createVideoMiniatureFromExisting({
      inputPath: thumbnailPhysicalFile.path,
      video,
      type: ThumbnailType.MINIATURE,
      automaticallyGenerated: false
    })
  }

  return undefined
}

async function processPreview (req: express.Request, video: MVideoThumbnail): Promise<MThumbnail> {
  const previewField = req.files ? req.files['previewfile'] : undefined
  if (previewField) {
    const previewPhysicalFile = previewField[0]

    return createVideoMiniatureFromExisting({
      inputPath: previewPhysicalFile.path,
      video,
      type: ThumbnailType.PREVIEW,
      automaticallyGenerated: false
    })
  }

  return undefined
}

async function processThumbnailFromUrl (url: string, video: MVideoThumbnail) {
  try {
    return createVideoMiniatureFromUrl({ downloadUrl: url, video, type: ThumbnailType.MINIATURE })
  } catch (err) {
    logger.warn('Cannot generate video thumbnail %s for %s.', url, video.url, { err })
    return undefined
  }
}

async function processPreviewFromUrl (url: string, video: MVideoThumbnail) {
  try {
    return createVideoMiniatureFromUrl({ downloadUrl: url, video, type: ThumbnailType.PREVIEW })
  } catch (err) {
    logger.warn('Cannot generate video preview %s for %s.', url, video.url, { err })
    return undefined
  }
}

async function insertIntoDB (parameters: {
  video: MVideoThumbnail
  thumbnailModel: MThumbnail
  previewModel: MThumbnail
  videoChannel: MChannelAccountDefault
  tags: string[]
  videoImportAttributes: FilteredModelAttributes<VideoImportModel>
  user: MUser
}): Promise<MVideoImportFormattable> {
  const { video, thumbnailModel, previewModel, videoChannel, tags, videoImportAttributes, user } = parameters

  const videoImport = await sequelizeTypescript.transaction(async t => {
    const sequelizeOptions = { transaction: t }

    // Save video object in database
    const videoCreated = await video.save(sequelizeOptions) as (MVideoAccountDefault & MVideoWithBlacklistLight & MVideoTag)
    videoCreated.VideoChannel = videoChannel

    if (thumbnailModel) await videoCreated.addAndSaveThumbnail(thumbnailModel, t)
    if (previewModel) await videoCreated.addAndSaveThumbnail(previewModel, t)

    await autoBlacklistVideoIfNeeded({
      video: videoCreated,
      user,
      notify: false,
      isRemote: false,
      isNew: true,
      transaction: t
    })

    await setVideoTags({ video: videoCreated, tags, transaction: t })

    // Create video import object in database
    const videoImport = await VideoImportModel.create(
      Object.assign({ videoId: videoCreated.id }, videoImportAttributes),
      sequelizeOptions
    ) as MVideoImportFormattable
    videoImport.Video = videoCreated

    return videoImport
  })

  return videoImport
}
