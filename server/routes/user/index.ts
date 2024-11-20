import JellyfinAPI from '@server/api/jellyfin';
import PlexTvAPI from '@server/api/plextv';
import TautulliAPI from '@server/api/tautulli';
import { MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { UserPushSubscription } from '@server/entity/UserPushSubscription';
import { Watchlist } from '@server/entity/Watchlist';
import type { WatchlistResponse } from '@server/interfaces/api/discoverInterfaces';
import type {
  QuotaResponse,
  UserRequestsResponse,
  UserResultsResponse,
  UserWatchDataResponse,
} from '@server/interfaces/api/userInterfaces';
import { hasPermission, Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { getHostname } from '@server/utils/getHostname';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import gravatarUrl from 'gravatar-url';
import { findIndex, sortBy } from 'lodash';
import { In } from 'typeorm';
import userSettingsRoutes from './usersettings';
import { default as generatePassword } from 'secure-random-password';
import PreparedEmail from '@server/lib/email';
import { UserSettings } from '@server/entity/UserSettings';
import {
  defineBackendMessages,
  getTranslation,
} from '@server/utils/backendMessages';


const messages = defineBackendMessages('components.generatedpassword', {
  subject: '{name}, your Jellyfin account has been created.',
  greeting: 'Hi, {name}.',
  accessInfo: 'You now have access to Jellyfin and Jellyseerr as they sharing same account with the following credentials:',
  credentials: '{username} | {password}',
  passwordInfo: 'You can change your password at any time by visiting your account "Profile" directly in Jellyfin.',
  jellyseerrInfo: 'You can request for movies, shows and music on Jellyseerr via the button below or with {domain}',
  jellyfinInfo: 'You can access your account and play media on Jellyfin via the button below or with {jellyfinUrl}',
  openButton: 'Open {service}',
  warning: 'Your account is strictly personal and should not be shared. Feel free to use it as much as you want within the same household, but be aware that any suspicious activity may result in a permanent ban.',
  openJellyseerr: 'Open Jellyseerr',
  openJellyfin: 'Open Jellyfin',
  downloads: 'Jellyfin is available for free on the following platforms, the Samsung app should be available shortly:',
});

interface CreateJellyfinUserRequest {
  username: string;
  email: string;
  password?: string;
  locale?: string;
}

interface ImportJellyfinUserRequest {
  jellyfinUserIds: string[];
  email?: string;
  locale?: string;
}

const router = Router();

const getFirstName = (username: string): string => {
  if (username && username.includes('.')) {
    const [firstName] = username.split('.');
    return `${firstName.charAt(0).toUpperCase()}${firstName.slice(1)}`;
  }
  return `${username.charAt(0).toUpperCase()}${username.slice(1)}`;
};

router.get('/', async (req, res, next) => {
  try {
    const pageSize = req.query.take ? Number(req.query.take) : 10;
    const skip = req.query.skip ? Number(req.query.skip) : 0;
    let query = getRepository(User).createQueryBuilder('user');

    switch (req.query.sort) {
      case 'updated':
        query = query.orderBy('user.updatedAt', 'DESC');
        break;
      case 'displayname':
        query = query.orderBy(
          `CASE WHEN (user.username IS NULL OR user.username = '') THEN (
             CASE WHEN (user.plexUsername IS NULL OR user.plexUsername = '') THEN (
               CASE WHEN (user.jellyfinUsername IS NULL OR user.jellyfinUsername = '') THEN
                 user.email
               ELSE
                 LOWER(user.jellyfinUsername)
               END)
             ELSE
               LOWER(user.jellyfinUsername)
             END)
           ELSE
             LOWER(user.username)
           END`,
          'ASC'
        );
        break;
      case 'requests':
        query = query
          .addSelect((subQuery) => {
            return subQuery
              .select('COUNT(request.id)', 'requestCount')
              .from(MediaRequest, 'request')
              .where('request.requestedBy.id = user.id');
          }, 'requestCount')
          .orderBy('requestCount', 'DESC');
        break;
      case 'subscriptionStatus':
        query = query.orderBy('user.subscriptionStatus', 'ASC');
        break;
      case 'subscriptionExpirationDate':
        query = query.orderBy('user.subscriptionExpirationDate', 'ASC');
        break;
      case 'suspiciousActivityCount':
        query = query.orderBy('user.suspiciousActivityCount', 'ASC');
        break;
      default:
        query = query.orderBy('user.id', 'ASC');
        break;
    }

    const [users, userCount] = await query
      .take(pageSize)
      .skip(skip)
      .getManyAndCount();

    return res.status(200).json({
      pageInfo: {
        pages: Math.ceil(userCount / pageSize),
        pageSize,
        results: userCount,
        page: Math.ceil(skip / pageSize) + 1,
      },
      results: User.filterMany(
        users,
        req.user?.hasPermission(Permission.MANAGE_USERS)
      ),
    } as UserResultsResponse);
  } catch (e) {
    next({ status: 500, message: e.message });
  }
});

router.post(
  '/',
  isAuthenticated(Permission.MANAGE_USERS),
  async (req, res, next) => {
    try {
      const settings = getSettings();

      const body = req.body;
      const email = body.email || body.username;
      const userRepository = getRepository(User);

      const existingUser = await userRepository
        .createQueryBuilder('user')
        .where('user.email = :email', {
          email: email.toLowerCase(),
        })
        .getOne();

      if (existingUser) {
        return next({
          status: 409,
          message: 'User already exists with submitted email.',
          errors: ['USER_EXISTS'],
        });
      }

      const passedExplicitPassword = body.password && body.password.length > 0;
      const avatar = gravatarUrl(email, { default: 'mm', size: 200 });

      if (
        !passedExplicitPassword &&
        !settings.notifications.agents.email.enabled
      ) {
        throw new Error('Email notifications must be enabled');
      }

      const user = new User({
        email,
        avatar: body.avatar ?? avatar,
        username: body.username,
        password: body.password,
        permissions: settings.main.defaultPermissions,
        plexToken: '',
        userType: UserType.LOCAL,
      });

      if (passedExplicitPassword) {
        await user?.setPassword(body.password);
      } else {
        await user?.generatePassword();
      }

      await userRepository.save(user);
      return res.status(201).json(user.filter());
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

router.post<
  never,
  unknown,
  {
    endpoint: string;
    p256dh: string;
    auth: string;
  }
>('/registerPushSubscription', async (req, res, next) => {
  try {
    const userPushSubRepository = getRepository(UserPushSubscription);

    const existingSubs = await userPushSubRepository.find({
      where: { auth: req.body.auth },
    });

    if (existingSubs.length > 0) {
      logger.debug(
        'User push subscription already exists. Skipping registration.',
        { label: 'API' }
      );
      return res.status(204).send();
    }

    const userPushSubscription = new UserPushSubscription({
      auth: req.body.auth,
      endpoint: req.body.endpoint,
      p256dh: req.body.p256dh,
      user: req.user,
    });

    userPushSubRepository.save(userPushSubscription);

    return res.status(204).send();
  } catch (e) {
    logger.error('Failed to register user push subscription', {
      label: 'API',
    });
    next({ status: 500, message: 'Failed to register subscription.' });
  }
});

router.get<{ id: string }>('/:id', async (req, res, next) => {
  try {
    const userRepository = getRepository(User);

    const user = await userRepository.findOneOrFail({
      where: { id: Number(req.params.id) },
    });

    return res
      .status(200)
      .json(user.filter(req.user?.hasPermission(Permission.MANAGE_USERS)));
  } catch (e) {
    next({ status: 404, message: 'User not found.' });
  }
});

router.use('/:id/settings', userSettingsRoutes);

router.get<{ id: string }, UserRequestsResponse>(
  '/:id/requests',
  async (req, res, next) => {
    const pageSize = req.query.take ? Number(req.query.take) : 20;
    const skip = req.query.skip ? Number(req.query.skip) : 0;

    try {
      const user = await getRepository(User).findOne({
        where: { id: Number(req.params.id) },
      });

      if (!user) {
        return next({ status: 404, message: 'User not found.' });
      }

      if (
        user.id !== req.user?.id &&
        !req.user?.hasPermission(
          [Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW],
          { type: 'or' }
        )
      ) {
        return next({
          status: 403,
          message: "You do not have permission to view this user's requests.",
        });
      }

      const [requests, requestCount] = await getRepository(MediaRequest)
        .createQueryBuilder('request')
        .leftJoinAndSelect('request.media', 'media')
        .leftJoinAndSelect('request.seasons', 'seasons')
        .leftJoinAndSelect('request.modifiedBy', 'modifiedBy')
        .leftJoinAndSelect('request.requestedBy', 'requestedBy')
        .andWhere('requestedBy.id = :id', {
          id: user.id,
        })
        .orderBy('request.id', 'DESC')
        .take(pageSize)
        .skip(skip)
        .getManyAndCount();

      return res.status(200).json({
        pageInfo: {
          pages: Math.ceil(requestCount / pageSize),
          pageSize,
          results: requestCount,
          page: Math.ceil(skip / pageSize) + 1,
        },
        results: requests,
      });
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

export const canMakePermissionsChange = (
  permissions: number,
  user?: User
): boolean =>
  // Only let the owner grant admin privileges
  !(hasPermission(Permission.ADMIN, permissions) && user?.id !== 1);

router.put<
  Record<string, never>,
  Partial<User>[],
  { ids: string[]; permissions: number }
>('/', isAuthenticated(Permission.MANAGE_USERS), async (req, res, next) => {
  try {
    const isOwner = req.user?.id === 1;

    if (!canMakePermissionsChange(req.body.permissions, req.user)) {
      return next({
        status: 403,
        message: 'You do not have permission to grant this level of access',
      });
    }

    const userRepository = getRepository(User);

    const users: User[] = await userRepository.find({
      where: {
        id: In(
          isOwner ? req.body.ids : req.body.ids.filter((id) => Number(id) !== 1)
        ),
      },
    });

    const updatedUsers = await Promise.all(
      users.map(async (user) => {
        return userRepository.save(<User>{
          ...user,
          ...{ permissions: req.body.permissions },
        });
      })
    );

    return res.status(200).json(updatedUsers);
  } catch (e) {
    next({ status: 500, message: e.message });
  }
});

router.put<{ id: string }>(
  '/:id',
  isAuthenticated(Permission.MANAGE_USERS),
  async (req, res, next) => {
    try {
      const userRepository = getRepository(User);

      const user = await userRepository.findOneOrFail({
        where: { id: Number(req.params.id) },
      });

      // Only let the owner user modify themselves
      if (user.id === 1 && req.user?.id !== 1) {
        return next({
          status: 403,
          message: 'You do not have permission to modify this user',
        });
      }

      if (!canMakePermissionsChange(req.body.permissions, req.user)) {
        return next({
          status: 403,
          message: 'You do not have permission to grant this level of access',
        });
      }

      Object.assign(user, {
        username: req.body.username,
        permissions: req.body.permissions,
      });

      await userRepository.save(user);

      return res.status(200).json(user.filter());
    } catch (e) {
      next({ status: 404, message: 'User not found.' });
    }
  }
);

router.delete<{ id: string }>(
  '/:id',
  isAuthenticated(Permission.MANAGE_USERS),
  async (req, res, next) => {
    try {
      const userRepository = getRepository(User);
      const settings = getSettings();
      const user = await userRepository
        .createQueryBuilder('user')
        .leftJoinAndSelect('user.requests', 'requests')
        .where('user.id = :id', { id: Number(req.params.id) })
        .getOne();

      if (!user) {
        return next({ status: 404, message: 'User not found.' });
      }

      if (user.userType === UserType.JELLYFIN && user.jellyfinUserId) {
        try {
          const admin = await userRepository
            .createQueryBuilder('admin')
            .where('admin.id = :id', { id: 1 })
            .select(['admin.jellyfinDeviceId'])
            .getOne();

          const jellyfinApi = new JellyfinAPI(
            getHostname(),
            settings.jellyfin.apiKey ?? '',
            admin?.jellyfinDeviceId ?? ''
          );

          await jellyfinApi.deleteUser(user.jellyfinUserId);
        } catch (e) {
          if (e.response?.status === 404) {
            logger.warn('User not found in Jellyfin, continuing with local deletion', {
              label: 'API',
              jellyfinUserId: user.jellyfinUserId,
            });
          } else {
            logger.error('Failed to delete Jellyfin user', {
              label: 'API',
              errorMessage: e.message,
              jellyfinUserId: user.jellyfinUserId,
            });
          }
        }
      }

      if (user.requests?.length > 0) {
        await getRepository(MediaRequest)
          .createQueryBuilder()
          .delete()
          .where('requestedById = :userId', { userId: user.id })
          .execute();
      }

      await userRepository
        .createQueryBuilder()
        .delete()
        .where('id = :id', { id: user.id })
        .execute();

      return res.status(200).json({ success: true });
    } catch (e) {
      logger.error('Failed to delete user', {
        label: 'API',
        errorMessage: e.message,
      });
      next({ status: 500, message: 'Failed to delete user' });
    }
  }
);

router.post(
  '/import-from-plex',
  isAuthenticated(Permission.MANAGE_USERS),
  async (req, res, next) => {
    try {
      const settings = getSettings();
      const userRepository = getRepository(User);
      const body = req.body as { plexIds: string[] } | undefined;

      // taken from auth.ts
      const mainUser = await userRepository.findOneOrFail({
        select: { id: true, plexToken: true },
        where: { id: 1 },
      });
      const mainPlexTv = new PlexTvAPI(mainUser.plexToken ?? '');

      const plexUsersResponse = await mainPlexTv.getUsers();
      const createdUsers: User[] = [];
      for (const rawUser of plexUsersResponse.MediaContainer.User) {
        const account = rawUser.$;

        if (account.email) {
          const user = await userRepository
            .createQueryBuilder('user')
            .where('user.plexId = :id', { id: account.id })
            .orWhere('user.email = :email', {
              email: account.email.toLowerCase(),
            })
            .getOne();

          if (user) {
            // Update the user's avatar with their Plex thumbnail, in case it changed
            user.avatar = account.thumb;
            user.email = account.email;
            user.plexUsername = account.username;

            // In case the user was previously a local account
            if (user.userType === UserType.LOCAL) {
              user.userType = UserType.PLEX;
              user.plexId = parseInt(account.id);
            }
            await userRepository.save(user);
          } else if (!body || body.plexIds.includes(account.id)) {
            if (await mainPlexTv.checkUserAccess(parseInt(account.id))) {
              const newUser = new User({
                plexUsername: account.username,
                email: account.email,
                permissions: settings.main.defaultPermissions,
                plexId: parseInt(account.id),
                plexToken: '',
                avatar: account.thumb,
                userType: UserType.PLEX,
              });
              await userRepository.save(newUser);
              createdUsers.push(newUser);
            }
          }
        }
      }

      return res.status(201).json(User.filterMany(createdUsers));
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

router.post(
  '/import-from-jellyfin',
  isAuthenticated(Permission.MANAGE_USERS),
  async (
    req: Request<Record<string, never>, unknown, ImportJellyfinUserRequest>,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const settings = getSettings();
      const userRepository = getRepository(User);
      const body = req.body;

      // taken from auth.ts
      const admin = await userRepository.findOneOrFail({
        where: { id: 1 },
        select: ['id', 'jellyfinDeviceId', 'jellyfinUserId'],
        order: { id: 'ASC' },
      });

      const hostname = getHostname();
      const jellyfinClient = new JellyfinAPI(
        hostname,
        settings.jellyfin.apiKey,
        admin.jellyfinDeviceId ?? ''
      );
      jellyfinClient.setUserId(admin.jellyfinUserId ?? '');

      //const jellyfinUsersResponse = await jellyfinClient.getUsers();
      const createdUsers: User[] = [];

      jellyfinClient.setUserId(admin.jellyfinUserId ?? '');
      const jellyfinUsers = await jellyfinClient.getUsers();

      for (const jellyfinUserId of body.jellyfinUserIds) {
        const jellyfinUser = jellyfinUsers.users.find(
          (user) => user.Id === jellyfinUserId
        );

        const user = await userRepository.findOne({
          select: ['id', 'jellyfinUserId'],
          where: { jellyfinUserId: jellyfinUserId },
        });

        if (!user) {
          let displayName = jellyfinUser?.Name ?? '';

          if (jellyfinUser?.Name && jellyfinUser.Name.includes('.')) {
            const [firstname, lastname] = jellyfinUser.Name.split('.');
            if (firstname && lastname) {
              displayName = `${firstname.charAt(0).toUpperCase()}${firstname.slice(1)} ${lastname.toUpperCase()}`;
            }
          }

          const userSettingsRepository = getRepository(UserSettings);

          const newUser = new User({
            username: displayName,
            jellyfinUsername: jellyfinUser?.Name,
            jellyfinUserId: jellyfinUser?.Id,
            jellyfinDeviceId: Buffer.from(
              `BOT_jellyseerr_${jellyfinUser?.Name ?? ''}`
            ).toString('base64'),
            email: body.email || jellyfinUser?.Name,
            permissions: settings.main.defaultPermissions,
            avatar: `/avatarproxy/${jellyfinUser?.Id}`,
            userType:
              settings.main.mediaServerType === MediaServerType.JELLYFIN
                ? UserType.JELLYFIN
                : UserType.EMBY,
          });

          // Create settings first
          const userSettings = new UserSettings({
            user: newUser,
            locale: body.locale || settings.main.locale || 'en',
          });

          // Save both entities
          await userRepository.save(newUser);
          await userSettingsRepository.save(userSettings);

          newUser.settings = userSettings;
          createdUsers.push(newUser);
        }
      }
      return res.status(201).json(User.filterMany(createdUsers));
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

router.post('/jellyfinuser',
  isAuthenticated(Permission.MANAGE_USERS),
  async (
    req: Request<Record<string, never>, unknown, CreateJellyfinUserRequest>,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const { username, email, password: userPassword, locale } = req.body;
      const password = userPassword || generatePassword.randomPassword();

      const settings = getSettings();
      const protocol = settings.jellyfin.useSsl ? 'https' : 'http';
      const jellyfinUrl = `${protocol}://${settings.jellyfin.ip}`;

      const userRepository = getRepository(User);
      const admin = await userRepository.findOneOrFail({
        where: { id: 1 },
        select: ['id', 'jellyfinDeviceId', 'jellyfinUserId'],
        order: { id: 'ASC' },
      });

      const jellyfinApi = new JellyfinAPI(
        getHostname(),
        settings.jellyfin.apiKey,
        admin.jellyfinDeviceId ?? ''
      );

      const jellyfinUser = await jellyfinApi.createUser({
        Name: username,
        Password: password,
      });

      if (email) {
        const { applicationTitle, applicationUrl } = settings.main;
        try {
          logger.info(`Sending generated password email for ${email}`, {
            label: 'User Management',
          });

          const emailTemplatePath = '/app/dist/templates/email/generatedpassword';

          const emailService = new PreparedEmail(settings.notifications.agents.email);
          await emailService.send({
            template: emailTemplatePath,
            message: {
              to: email,
            },
            locals: {
              password,
              applicationUrl,
              jellyfinUrl,
              applicationTitle,
              recipientName: username,
              firstName: getFirstName(username),
              translations: {
                subject: getTranslation(messages, 'subject', locale ?? 'en')
                  .replace('{name}', getFirstName(username)),
                greeting: getTranslation(messages, 'greeting', locale ?? 'en')
                  .replace('{name}', getFirstName(username)),
                accessInfo: getTranslation(messages, 'accessInfo', locale ?? 'en'),
                passwordInfo: getTranslation(messages, 'passwordInfo', locale ?? 'en'),
                jellyseerrInfo: getTranslation(messages, 'jellyseerrInfo', locale ?? 'en')
                  .replace('{domain}', applicationUrl),
                jellyfinInfo: getTranslation(messages, 'jellyfinInfo', locale ?? 'en')
                  .replace('{jellyfinUrl}', jellyfinUrl),
                openJellyseerr: getTranslation(messages, 'openJellyseerr', locale ?? 'en')
                  .replace('{applicationTitle}', applicationTitle),
                openJellyfin: getTranslation(messages, 'openJellyfin', locale ?? 'en')
                  .replace('{jellyfinName}', settings.jellyfin.name || 'Jellyfin'),
                downloads: getTranslation(messages, 'downloads', locale ?? 'en'),
                warning: getTranslation(messages, 'warning', locale ?? 'en')
              }
            },
          });
        } catch (e) {
          logger.error('Failed to send password email', {
            label: 'User Management',
            message: e.message,
          });
        }
      }

      return res.status(201).json({
        ...jellyfinUser,
        password: password,
        locale: locale || settings.main.locale || 'en',
      });
    } catch (error) {
      next(error);
    }
});

router.post('/:id/welcome-mail',
  isAuthenticated(Permission.ADMIN),
  async (req, res, next) => {
    try {
      const settings = getSettings();
      const userRepository = getRepository(User);

      const user = await userRepository.findOne({
        where: { id: Number(req.params.id) },
        relations: ['settings']
      });

      if (!user) {
        throw new Error('User not found');
      }

      if (user.userType !== UserType.JELLYFIN || !user.jellyfinUserId) {
        throw new Error('User is not a Jellyfin user');
      }

      const newPassword = generatePassword.randomPassword();
      const protocol = settings.jellyfin.useSsl ? 'https' : 'http';
      const jellyfinUrl = `${protocol}://${settings.jellyfin.ip}`;
      const { applicationTitle, applicationUrl } = settings.main;

      const admin = await userRepository.findOneOrFail({
        where: { id: 1 },
        select: ['id', 'jellyfinDeviceId']
      });

      const jellyfinApi = new JellyfinAPI(
        getHostname(),
        settings.jellyfin.apiKey,
        admin.jellyfinDeviceId ?? ''
      );

      await jellyfinApi.resetUserPassword(user.jellyfinUserId, newPassword);

      logger.info(`Sending generated password email for ${user.email}`, {
        label: 'User Management',
      });

      const emailTemplatePath = '/app/dist/templates/email/generatedpassword';
      const emailService = new PreparedEmail(settings.notifications.agents.email);

      await emailService.send({
        template: emailTemplatePath,
        message: {
          to: user.email,
        },
        locals: {
          password: newPassword,
          applicationUrl,
          jellyfinUrl,
          applicationTitle,
          recipientName: user.jellyfinUsername,
          firstName: getFirstName(user.jellyfinUsername ?? ''),
          translations: {
            subject: getTranslation(messages, 'subject', user.settings?.locale ?? 'en')
              .replace('{name}', getFirstName(user.jellyfinUsername ?? '')),
            greeting: getTranslation(messages, 'greeting', user.settings?.locale ?? 'en')
              .replace('{name}', getFirstName(user.jellyfinUsername ?? '')),
            accessInfo: getTranslation(messages, 'accessInfo', user.settings?.locale ?? 'en'),
            passwordInfo: getTranslation(messages, 'passwordInfo', user.settings?.locale ?? 'en'),
            jellyseerrInfo: getTranslation(messages, 'jellyseerrInfo', user.settings?.locale ?? 'en')
              .replace('{domain}', applicationUrl),
            jellyfinInfo: getTranslation(messages, 'jellyfinInfo', user.settings?.locale ?? 'en')
              .replace('{jellyfinUrl}', jellyfinUrl),
            openJellyseerr: getTranslation(messages, 'openJellyseerr', user.settings?.locale ?? 'en')
              .replace('{applicationTitle}', applicationTitle),
            openJellyfin: getTranslation(messages, 'openJellyfin', user.settings?.locale ?? 'en')
              .replace('{jellyfinName}', settings.jellyfin.name || 'Jellyfin'),
            downloads: getTranslation(messages, 'downloads', user.settings?.locale ?? 'en'),
            warning: getTranslation(messages, 'warning', user.settings?.locale ?? 'en')
          }
        },
      });

      return res.status(200).json({ success: true });
    } catch (error) {
      logger.error('Failed to reset password or send welcome email', {
        label: 'User Management',
        errorMessage: error.message,
      });
      next(error);
    }
});

router.get<{ id: string }, QuotaResponse>(
  '/:id/quota',
  async (req, res, next) => {
    try {
      const userRepository = getRepository(User);

      if (
        Number(req.params.id) !== req.user?.id &&
        !req.user?.hasPermission(
          [Permission.MANAGE_USERS, Permission.MANAGE_REQUESTS],
          { type: 'and' }
        )
      ) {
        return next({
          status: 403,
          message:
            "You do not have permission to view this user's request limits.",
        });
      }

      const user = await userRepository.findOneOrFail({
        where: { id: Number(req.params.id) },
      });

      const quotas = await user.getQuota();

      return res.status(200).json(quotas);
    } catch (e) {
      next({ status: 404, message: e.message });
    }
  }
);

router.get<{ id: string }, UserWatchDataResponse>(
  '/:id/watch_data',
  async (req, res, next) => {
    if (
      Number(req.params.id) !== req.user?.id &&
      !req.user?.hasPermission(Permission.ADMIN)
    ) {
      return next({
        status: 403,
        message:
          "You do not have permission to view this user's recently watched media.",
      });
    }

    const settings = getSettings().tautulli;

    if (!settings.hostname || !settings.port || !settings.apiKey) {
      return next({
        status: 404,
        message: 'Tautulli API not configured.',
      });
    }

    try {
      const user = await getRepository(User).findOneOrFail({
        where: { id: Number(req.params.id) },
        select: { id: true, plexId: true },
      });

      const tautulli = new TautulliAPI(settings);

      const watchStats = await tautulli.getUserWatchStats(user);
      const watchHistory = await tautulli.getUserWatchHistory(user);

      const recentlyWatched = sortBy(
        await getRepository(Media).find({
          where: [
            {
              mediaType: MediaType.MOVIE,
              ratingKey: In(
                watchHistory
                  .filter((record) => record.media_type === 'movie')
                  .map((record) => record.rating_key)
              ),
            },
            {
              mediaType: MediaType.MOVIE,
              ratingKey4k: In(
                watchHistory
                  .filter((record) => record.media_type === 'movie')
                  .map((record) => record.rating_key)
              ),
            },
            {
              mediaType: MediaType.TV,
              ratingKey: In(
                watchHistory
                  .filter((record) => record.media_type === 'episode')
                  .map((record) => record.grandparent_rating_key)
              ),
            },
            {
              mediaType: MediaType.TV,
              ratingKey4k: In(
                watchHistory
                  .filter((record) => record.media_type === 'episode')
                  .map((record) => record.grandparent_rating_key)
              ),
            },
          ],
        }),
        [
          (media) =>
            findIndex(
              watchHistory,
              (record) =>
                (!!media.ratingKey &&
                  parseInt(media.ratingKey) ===
                    (record.media_type === 'movie'
                      ? record.rating_key
                      : record.grandparent_rating_key)) ||
                (!!media.ratingKey4k &&
                  parseInt(media.ratingKey4k) ===
                    (record.media_type === 'movie'
                      ? record.rating_key
                      : record.grandparent_rating_key))
            ),
        ]
      );

      return res.status(200).json({
        recentlyWatched,
        playCount: watchStats.total_plays,
      });
    } catch (e) {
      logger.error('Something went wrong fetching user watch data', {
        label: 'API',
        errorMessage: e.message,
        userId: req.params.id,
      });
      next({
        status: 500,
        message: 'Failed to fetch user watch data.',
      });
    }
  }
);

router.get<{ id: string }, WatchlistResponse>(
  '/:id/watchlist',
  async (req, res, next) => {
    if (
      Number(req.params.id) !== req.user?.id &&
      !req.user?.hasPermission(
        [Permission.MANAGE_REQUESTS, Permission.WATCHLIST_VIEW],
        {
          type: 'or',
        }
      )
    ) {
      return next({
        status: 403,
        message: "You do not have permission to view this user's Watchlist.",
      });
    }

    const itemsPerPage = 20;
    const page = Number(req.query.page) ?? 1;
    const offset = (page - 1) * itemsPerPage;

    const user = await getRepository(User).findOneOrFail({
      where: { id: Number(req.params.id) },
      select: ['id', 'plexToken'],
    });

    if (user) {
      const [result, total] = await getRepository(Watchlist).findAndCount({
        where: { requestedBy: { id: user?.id } },
        relations: {
          /*requestedBy: true,media:true*/
        },
        // loadRelationIds: true,
        take: itemsPerPage,
        skip: offset,
      });
      if (total) {
        return res.json({
          page: page,
          totalPages: Math.ceil(total / itemsPerPage),
          totalResults: total,
          results: result,
        });
      }
    }

    // We will just return an empty array if the user has no Plex token
    if (!user.plexToken) {
      return res.json({
        page: 1,
        totalPages: 1,
        totalResults: 0,
        results: [],
      });
    }

    const plexTV = new PlexTvAPI(user.plexToken);

    const watchlist = await plexTV.getWatchlist({ offset });

    return res.json({
      page,
      totalPages: Math.ceil(watchlist.totalSize / itemsPerPage),
      totalResults: watchlist.totalSize,
      results: watchlist.items.map((item) => ({
        ratingKey: item.ratingKey,
        title: item.title,
        mediaType: item.type === 'show' ? 'tv' : 'movie',
        tmdbId: item.tmdbId,
      })),
    });
  }
);

export default router;
