import * as Prisma from "@prisma/client";
import { Session, User, VerificationRequest } from "@prisma/client";
import { createHash, randomBytes } from "crypto";
import { klona } from "klona";
import LRU from "lru-cache";
import { AppOptions } from "next-auth";
import { Adapter, AdapterInstance, EmailSessionProvider, Profile } from "next-auth/adapters";
// @ts-ignore
import { CreateUserError } from "next-auth/dist/lib/errors";
// @ts-ignore
import logger from "next-auth/dist/lib/logger";

const sessionCache = new LRU({
  maxAge: 24 * 60 * 60 * 1000,
  max: 1000,
});

const userCache = new LRU<Prisma.User['id'], Prisma.User>({
  maxAge: 24 * 60 * 60 * 1000,
  max: 1000,
});

const maxAge = (expires?: string | number | Date | null) =>
  expires ? new Date(expires).getTime() - Date.now() : undefined;
type IsValid<T extends Prisma.PrismaClient, U extends keyof T> = Required extends keyof T[U] ?  Required extends keyof T[U] ? T[U][Required] extends (args?:any) => any ? 1: 0 : 0 : 0
type Required = "create" | "findUnique" | "delete" | "update"
type Filter<T extends Prisma.PrismaClient> = {
  [K in keyof T]-?: {
      1: K;
      0: never;
  }[IsValid<T, K>];
}[keyof T];

// type isValid<T extends Prisma.PrismaClient, U> = T[U] extends  
export default function PrismaAdapter<
  T extends Prisma.PrismaClient,
  U extends Filter<T>,
  A extends Filter<T>,
  S extends Filter<T>,
  VR extends Filter<T>
>(config: {
  prisma: T;
  modelMapping: {
    User: U;
    Account: A;
    Session: S;
    VerificationRequest: VR;
  }}): Adapter<User,Profile, Session, VerificationRequest> {
  const {
    prisma,
    modelMapping 
  } = config;

  const { User, Account, Session, VerificationRequest } = modelMapping;

  async function getAdapter(appOptions: AppOptions): Promise<AdapterInstance<User, Profile, Session, VerificationRequest>>  {
    function debug(debugCode: string, ...args: any) {
      logger.debug(`PRISMA_${debugCode}`, ...args);
    }

    if (appOptions && (!appOptions.session || !appOptions.session.maxAge)) {
      debug(
        "GET_ADAPTER",
        "Session expiry not configured (defaulting to 30 days"
      );
    }

    const defaultSessionMaxAge = 30 * 24 * 60 * 60 * 1000;
    const sessionMaxAge =
      appOptions?.session?.maxAge
        ? appOptions.session.maxAge * 1000
        : defaultSessionMaxAge;
    const sessionUpdateAge =
      appOptions?.session?.updateAge
        ? appOptions.session.updateAge * 1000
        : 0;

    async function createUser(profile: Profile & {emailVerified?: Date}) {
      debug("CREATE_USER", profile);
      try {
        const user = await prisma[User as 'user'].create({
          data: {
            name: profile.name,
            email: profile.email,
            image: profile.image,
            emailVerified: profile.emailVerified
              ? profile.emailVerified.toISOString()
              : null,
          },
        });
        userCache.set(user.id, user);
        return user;
      } catch (error) {
        logger.error("CREATE_USER_ERROR", error);
        return Promise.reject(new CreateUserError(error));
      }
    }

    async function getUser(id: number) {
      debug("GET_USER", id);
      try {
        const cachedUser = userCache.get(id);
        if (cachedUser) {
          debug("GET_USER - Fetched from LRU Cache", cachedUser);
          // stale while revalidate
          (async () => {
            const user = await prisma[User as 'user'].findUnique({ where: { id }, rejectOnNotFound: true }) as Prisma.User;
            userCache.set(user.id, user);
          })();
          return cachedUser;
        }
        return prisma[User as 'user'].findUnique({ where: { id } });
      } catch (error) {
        logger.error("GET_USER_BY_ID_ERROR", error);
        // @ts-ignore
        return Promise.reject(new Error("GET_USER_BY_ID_ERROR", error));
      }
    }

    async function getUserByEmail(email?: string) {
      debug("GET_USER_BY_EMAIL", email);
      try {
        if (!email) {
          return Promise.resolve(null);
        }
        return prisma[User as 'user'].findUnique({ where: { email }, rejectOnNotFound: true }) as Promise<Prisma.User>;
      } catch (error) {
        logger.error("GET_USER_BY_EMAIL_ERROR", error);
        // @ts-ignore
        return Promise.reject(new Error("GET_USER_BY_EMAIL_ERROR", error));
      }
    }

    async function getUserByProviderAccountId(
      providerId: string,
      providerAccountId: string
    ) {
      debug("GET_USER_BY_PROVIDER_ACCOUNT_ID", providerId, providerAccountId);
      try {
        if (!providerId || !providerAccountId) return null;
        const account = await prisma[Account as 'account'].findUnique({
          where: {
            providerId_providerAccountId: {
              providerId: providerId,
              providerAccountId: providerAccountId,
            },
          },
          include: {
            user: true,
          },
          rejectOnNotFound: true
        }) 
        return account!.user 
      } catch (error) {
        logger.error("GET_USER_BY_PROVIDER_ACCOUNT_ID_ERROR", error);
        return Promise.reject(
          // @ts-ignore
          new Error("GET_USER_BY_PROVIDER_ACCOUNT_ID_ERROR", error)
        );
      }
    }

    async function updateUser(user: User) {
      debug("UPDATE_USER", user);
      try {
        const { id, name, email, image, emailVerified } = user;
        userCache.set(id, user);
        // @ts-ignore
        return prisma[User].update({
          where: { id },
          data: {
            name,
            email,
            image,
            emailVerified: emailVerified ? emailVerified.toISOString() : null,
          },
        });
      } catch (error) {
        logger.error("UPDATE_USER_ERROR", error);
        // @ts-ignore
        return Promise.reject(new Error("UPDATE_USER_ERROR", error));
      }
    }

    async function deleteUser(userId: number) {
      userCache.del(userId);
      debug("DELETE_USER", userId);
      try {
        return prisma[User as 'user'].delete({ where: { id: userId } });
      } catch (error) {
        logger.error("DELETE_USER_ERROR", error);
        // @ts-ignore
        return Promise.reject(new Error("DELETE_USER_ERROR", error));
      }
    }

    async function linkAccount(
      userId: number,
      providerId: string,
      providerType: string,
      providerAccountId: string,
      refreshToken: string,
      accessToken: string,
      accessTokenExpires: string | Date | null | undefined
    ) {
      debug(
        "LINK_ACCOUNT",
        userId,
        providerId,
        providerType,
        providerAccountId,
        refreshToken,
        accessToken,
        accessTokenExpires
      );
      try {
        return await prisma[Account as 'account'].create({
          data: {
            accessToken,
            refreshToken,
            providerAccountId: `${providerAccountId}`,
            providerId,
            providerType,
            accessTokenExpires,
            user: { connect: { id: userId } },
          },
        });
      } catch (error) {
        logger.error("LINK_ACCOUNT_ERROR", error);
        // @ts-ignore
        return Promise.reject(new Error("LINK_ACCOUNT_ERROR", error));
      }
    }

    async function unlinkAccount(
      userId: string,
      providerId: string,
      providerAccountId: string
    ) {
      debug("UNLINK_ACCOUNT", userId, providerId, providerAccountId);
      try {
        return prisma[Account as 'account'].delete({
          where: {
            providerId_providerAccountId: {
              providerAccountId: providerAccountId,
              providerId: providerId,
            },
          },
        });
      } catch (error) {
        logger.error("UNLINK_ACCOUNT_ERROR", error);
        // @ts-ignore
        return Promise.reject(new Error("UNLINK_ACCOUNT_ERROR", error));
      }
    }

    async function createSession(user: User) {
      debug("CREATE_SESSION", user);
      try {
        let expires: string | Date | null = null;
        const dateExpires = new Date();
        dateExpires.setTime(dateExpires.getTime() + sessionMaxAge);
        expires = dateExpires.toISOString();
        
        const session = {
          expires,
          sessionToken: randomBytes(32).toString("hex"),
          accessToken: randomBytes(32).toString("hex"),
          user,
        };

        const cachedSession = klona(session);

        sessionCache.set(session.sessionToken, cachedSession, maxAge(expires));

        return prisma[Session as 'session'].create({
          data: {
            expires,
            user: { connect: { id: user.id } },
            sessionToken: randomBytes(32).toString("hex"),
            accessToken: randomBytes(32).toString("hex"),
          },
        });
      } catch (error) {
        logger.error("CREATE_SESSION_ERROR", error);
        // @ts-ignore
        return Promise.reject(new Error("CREATE_SESSION_ERROR", error));
      }
    }

    async function getSession(sessionToken: string) {
      debug("GET_SESSION", sessionToken);
      try {
        const cachedSession = sessionCache.get(sessionToken);
        if (cachedSession) {
          debug("GET_SESSION - Fetched from LRU Cache", cachedSession);
          return cachedSession;
        }
        const session = await prisma[Session as 'session'].findUnique({
          where: { sessionToken: sessionToken },
        });

        // Check session has not expired (do not return it if it has)
        if (session && session.expires && new Date() > session.expires) {
          await prisma[Session as 'session'].delete({ where: { sessionToken } });
          return null;
        }

        session &&
          sessionCache.set(
            session.sessionToken,
            session,
            maxAge(session.expires)
          );

        return session;
      } catch (error) {
        logger.error("GET_SESSION_ERROR", error);
        // @ts-ignore
        return Promise.reject(new Error("GET_SESSION_ERROR", error));
      }
    }

    async function updateSession(session: Session, force: boolean) {
      debug("UPDATE_SESSION", session);
      try {
        if (
          sessionMaxAge &&
          (sessionUpdateAge || sessionUpdateAge === 0) &&
          session.expires
        ) {
          // Calculate last updated date, to throttle write updates to database
          // Formula: ({expiry date} - sessionMaxAge) + sessionUpdateAge
          //     e.g. ({expiry date} - 30 days) + 1 hour
          //
          // Default for sessionMaxAge is 30 days.
          // Default for sessionUpdateAge is 1 hour.
          const dateSessionIsDueToBeUpdated = new Date(session.expires);
          dateSessionIsDueToBeUpdated.setTime(
            dateSessionIsDueToBeUpdated.getTime() - sessionMaxAge
          );
          dateSessionIsDueToBeUpdated.setTime(
            dateSessionIsDueToBeUpdated.getTime() + sessionUpdateAge
          );

          // Trigger update of session expiry date and write to database, only
          // if the session was last updated more than {sessionUpdateAge} ago
          if (new Date() > dateSessionIsDueToBeUpdated) {
            const newExpiryDate = new Date();
            newExpiryDate.setTime(newExpiryDate.getTime() + sessionMaxAge);
            session.expires = newExpiryDate;
          } else if (!force) {
            return null;
          }
        } else {
          // If session MaxAge, session UpdateAge or session.expires are
          // missing then don't even try to save changes, unless force is set.
          if (!force) {
            return null;
          }
        }

        const { id, expires } = session;
        sessionCache.set(session.sessionToken, session, maxAge(expires));
        await prisma[Session as 'session'].update({ where: { id }, data: { expires } });
        return;
      } catch (error) {
        logger.error("UPDATE_SESSION_ERROR", error);
        // @ts-ignore
        return Promise.reject(new Error("UPDATE_SESSION_ERROR", error));
      }
    }

    async function deleteSession(sessionToken: string) {
      debug("DELETE_SESSION", sessionToken);
      try {
        sessionCache.del(sessionToken);
        return await prisma[Session as 'session'].delete({ where: { sessionToken } });
      } catch (error) {
        logger.error("DELETE_SESSION_ERROR", error);
        // @ts-ignore
        return Promise.reject(new Error("DELETE_SESSION_ERROR", error));
      }
    }

    async function createVerificationRequest(
      identifier: string,
      url: string,
      token:string,
      secret:string,
      provider: EmailSessionProvider
    ) {
      debug("CREATE_VERIFICATION_REQUEST", identifier);
      try {
        const { baseUrl } = appOptions;
        const { sendVerificationRequest, maxAge } = provider;

        // Store hashed token (using secret as salt) so that tokens cannot be exploited
        // even if the contents of the database is compromised.
        // @TODO Use bcrypt function here instead of simple salted hash
        const hashedToken = createHash("sha256")
          .update(`${token}${secret}`).digest('hex')

        let expires = '';
        if (maxAge) {
          const dateExpires = new Date();
          dateExpires.setTime(dateExpires.getTime() + maxAge * 1000);
          expires = dateExpires.toISOString();
        }

        // Save to database
        const verificationRequest = await prisma[VerificationRequest as 'verificationRequest'].create({
          data: {
            identifier,
            token: hashedToken,
            expires,
          },
        });

        // With the verificationCallback on a provider, you can send an email, or queue
        // an email to be sent, or perform some other action (e.g. send a text message)
        await sendVerificationRequest({
          identifier,
          url,
          token,
          baseUrl,
          provider,
        });

        return verificationRequest;
      } catch (error) {
        logger.error("CREATE_VERIFICATION_REQUEST_ERROR", error);
        return Promise.reject(
          // @ts-ignore
          new Error("CREATE_VERIFICATION_REQUEST_ERROR", error)
        );
      }
    }

    async function getVerificationRequest(identifier: string, token: string, secret: string, provider: string) {
      debug("GET_VERIFICATION_REQUEST", identifier, token);
      try {
        // Hash token provided with secret before trying to match it with database
        // @TODO Use bcrypt instead of salted SHA-256 hash for token
        const hashedToken = createHash("sha256")
          .update(`${token}${secret}`)
          .digest("hex");
        const verificationRequest = await prisma[
          VerificationRequest as 'verificationRequest'
        ].findUnique({
          where: { token: hashedToken },
        });

        if (
          verificationRequest &&
          verificationRequest.expires &&
          new Date() > verificationRequest.expires
        ) {
          // Delete verification entry so it cannot be used again
          await prisma[VerificationRequest as 'verificationRequest'].delete({
            where: { token: hashedToken },
          });
          return null;
        }

        return verificationRequest;
      } catch (error) {
        logger.error("GET_VERIFICATION_REQUEST_ERROR", error);
        return Promise.reject(
          // @ts-ignore
          new Error("GET_VERIFICATION_REQUEST_ERROR", error)
        );
      }
    }

    async function deleteVerificationRequest(
      identifier: string,
      token: string,
      secret: string,
      provider: string
    ) {
      debug("DELETE_VERIFICATION", identifier, token);
      try {
        // Delete verification entry so it cannot be used again
        const hashedToken = createHash("sha256")
          .update(`${token}${secret}`)
          .digest("hex");
        await prisma[VerificationRequest as 'verificationRequest'].delete({
          where: { token: hashedToken },
        });
      } catch (error) {
        logger.error("DELETE_VERIFICATION_REQUEST_ERROR", error);
        return Promise.reject(
          // @ts-ignore
          new Error("DELETE_VERIFICATION_REQUEST_ERROR", error)
        );
      }
    }
    // @ts-ignore
    return Promise.resolve({
      createUser,
      getUser,
      getUserByEmail,
      getUserByProviderAccountId,
      updateUser,
      deleteUser,
      linkAccount,
      unlinkAccount,
      createSession,
      getSession,
      updateSession,
      deleteSession,
      createVerificationRequest,
      getVerificationRequest,
      deleteVerificationRequest,
    });
  }

  return {
    getAdapter,
  };
}
// '<T extends User>(profile: T) => Promise<User>' is not assignable to type '(profile: Profile) => Promise<User>'.
PrismaAdapter({
  prisma: new Prisma.PrismaClient(),
  modelMapping: {
    User: "user",
    Account: "account",
    Session: "session",
    VerificationRequest: "verificationRequest",
  },
});


