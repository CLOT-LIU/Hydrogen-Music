import { onBeforeUnmount, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { getLikelist } from '../api/user'
import { useLibraryStore } from '../store/libraryStore'
import { useUserStore } from '../store/userStore'
import { isLogin } from '../utils/authority'
import { schedulePlaylistCacheInvalidation } from '../utils/cacheInvalidation'
import { resolveFavoritePlaylistMeta } from '../utils/favoritePlaylist'

const FAVORITE_PLAYLIST_SYNC_MIN_INTERVAL = 15 * 1000
const FAVORITE_PLAYLIST_SYNC_INTERVAL = 60 * 1000

const getLikelistSignature = ids => {
    if (!Array.isArray(ids)) return ''
    return ids.map(id => String(id)).join(',')
}

export function useFavoritePlaylistSync() {
    const router = useRouter()
    const userStore = useUserStore()
    const libraryStore = useLibraryStore()
    let lastSyncAt = 0
    let syncPromise = null
    let syncTimer = null

    const getFavoritePlaylistId = () => {
        const cachedId = userStore.favoritePlaylistId
        if (cachedId != null && cachedId !== '') return String(cachedId)

        const favoritePlaylist = resolveFavoritePlaylistMeta(
            libraryStore.playlistUserCreated,
            userStore.user?.userId
        )
        return favoritePlaylist?.id == null ? '' : String(favoritePlaylist.id)
    }

    const isAccountLibraryRoute = () => {
        return String(router.currentRoute.value?.fullPath || '').startsWith('/mymusic')
    }

    const isCurrentFavoritePlaylistRoute = favoritePlaylistId => {
        if (!favoritePlaylistId || router.currentRoute.value?.name != 'playlist') return false
        return String(router.currentRoute.value?.params?.id || '') == favoritePlaylistId
    }

    const shouldSyncOnForeground = () => {
        if (router.currentRoute.value?.name == 'mymusic') return true
        return isCurrentFavoritePlaylistRoute(getFavoritePlaylistId())
    }

    const syncFavoritePlaylist = async ({ force = false } = {}) => {
        const userId = userStore.user?.userId
        if (userStore.localOnlyMode || !userId || !isLogin()) return false
        if (syncPromise) return syncPromise

        const now = Date.now()
        if (!force && now - lastSyncAt < FAVORITE_PLAYLIST_SYNC_MIN_INTERVAL) return false
        lastSyncAt = now

        const syncUserId = String(userId)
        const startingSignature = getLikelistSignature(userStore.likelist)
        const task = (async () => {
            const result = await getLikelist(userId, { silent: true })
            if (String(userStore.user?.userId || '') != syncUserId) return false

            const currentSignature = getLikelistSignature(userStore.likelist)
            if (currentSignature != startingSignature) return false

            if (!Array.isArray(result?.ids)) return false
            const latestLikelist = result.ids
            if (getLikelistSignature(latestLikelist) == currentSignature) return false

            userStore.updateLikelist(latestLikelist)
            const favoritePlaylistId = getFavoritePlaylistId()
            schedulePlaylistCacheInvalidation()
            libraryStore.markPlaylistOverviewStale()
            if (favoritePlaylistId) libraryStore.invalidatePlaylistDetailCache(favoritePlaylistId)

            if (isCurrentFavoritePlaylistRoute(favoritePlaylistId)) {
                await libraryStore.updatePlaylistDetail(favoritePlaylistId, { deferRemaining: true })
            }
            return true
        })().catch(error => {
            console.warn('同步我喜欢的音乐失败:', error)
            return false
        })

        syncPromise = task
        try {
            return await task
        } finally {
            if (syncPromise === task) syncPromise = null
        }
    }

    const syncAfterReturningToApp = () => {
        if (!shouldSyncOnForeground()) return
        void syncFavoritePlaylist()
    }

    const handleVisibilityChange = () => {
        if (document.visibilityState == 'visible') syncAfterReturningToApp()
    }

    watch(
        () => router.currentRoute.value?.fullPath,
        () => {
            const favoritePlaylistId = getFavoritePlaylistId()
            if (isCurrentFavoritePlaylistRoute(favoritePlaylistId)) {
                void syncFavoritePlaylist({ force: true })
            }
        }
    )

    watch(
        () => userStore.user?.userId,
        userId => {
            if (!userId || !isAccountLibraryRoute()) return
            void syncFavoritePlaylist({ force: true })
        }
    )

    watch(
        () => userStore.favoritePlaylistId,
        favoritePlaylistId => {
            if (!favoritePlaylistId || !isCurrentFavoritePlaylistRoute(String(favoritePlaylistId))) return
            void syncFavoritePlaylist({ force: true })
        }
    )

    onMounted(() => {
        window.addEventListener('focus', syncAfterReturningToApp)
        document.addEventListener('visibilitychange', handleVisibilityChange)
        syncTimer = setInterval(() => {
            if (document.visibilityState == 'visible' && isCurrentFavoritePlaylistRoute(getFavoritePlaylistId())) {
                void syncFavoritePlaylist()
            }
        }, FAVORITE_PLAYLIST_SYNC_INTERVAL)
        syncAfterReturningToApp()
    })

    onBeforeUnmount(() => {
        window.removeEventListener('focus', syncAfterReturningToApp)
        document.removeEventListener('visibilitychange', handleVisibilityChange)
        if (syncTimer) clearInterval(syncTimer)
    })
}
