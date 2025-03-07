/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import { AWSError } from 'aws-sdk'
import { ServiceException } from '@aws-sdk/smithy-client'
import { isThrottlingError, isTransientError } from '@smithy/service-error-classification'
import { Result } from './telemetry/telemetry'
import { CancellationError } from './utilities/timeoutUtils'
import { isNonNullable } from './utilities/tsUtils'
import type * as fs from 'fs'
import type * as os from 'os'
import { CodeWhispererStreamingServiceException } from '@amzn/codewhisperer-streaming'
import { getUsername, isAutomation } from './vscode/env'
import { driveLetterRegex } from './utilities/pathUtils'

export const errorCode = {
    invalidConnection: 'InvalidConnection',
}

export interface ErrorInformation {
    /**
     * Error names are optional, but if provided they should be generic yet self-explanatory.
     *
     * A name does not need to precisely describe why something failed and instead should focus
     * on the overarching theme or module that caused the problem. For example, VS Code uses
     * `FileSystemError` for a diverse range of problems relating to their file system API.
     *
     * The choice of granularity for an error name largely comes down to what other errors are
     * possible; names are meant to immediately disambiguate from the potentially thousands of
     * other causes for a failure. If there is any doubt that a certain name might be confusing,
     * opt for something more specific and verbose.
     */
    readonly name?: string

    /**
     * An error code is used to describe specific failure modes within entire classes of errors.
     *
     * The exact value used here is free-form but should be kept stable whenever possible.
     * Value stability is especially important if any error handling logic directly relies on
     * error codes. Prefer using {@link ToolkitError.named} and narrowing this class if any
     * substantial logic is needed for handling specific error codes.
     *
     * As an example, one might choose to describe SSO error codes for extra type-safety:
     * ```ts
     * enum CreateTokenErrorCode {
     *     SlowDown = 'SlowDownException',
     *     ExpiredToken = 'ExpiredTokenException',
     *     UnauthorizedClient = 'UnauthorizedClientException',
     *     AuthorizationPending = 'AuthorizationPendingException',
     * }
     *
     * class CreateTokenError extends ToolkitError.named('CreateTokenError') {
     *     public constructor(public readonly code: CreateTokenErrorCode) {
     *         super('Failed to create SSO access token', { code })
     *     }
     * }
     * ```
     */
    readonly code?: string

    /**
     * Used to describe errors with a direct cause-effect relationship.
     *
     * See {@link code} for creating descriptive errors without a chainable root cause.
     */
    readonly cause?: Error

    /**
     * Structured information that may be used for logging.
     *
     * Consumers should strictly use this field for observability purposes as producers can
     * put whatever they want here.
     */
    readonly details?: Record<string, unknown>

    /**
     * Flag to determine if the error was from a user-initiated cancellation.
     */
    readonly cancelled?: boolean

    /**
     * A link to documentation relevant to this error.
     *
     * TODO: use this throughout the codebase.
     * TODO: prefer `Error.error_uri` if present (from OIDC/OAuth service)?
     */
    readonly documentationUri?: vscode.Uri
}

export class UnknownError extends Error {
    public override readonly name = 'UnknownError'

    public constructor(public readonly cause: unknown) {
        super(String(cause))
    }

    public static cast(obj: unknown): Error {
        return obj instanceof Error ? obj : new UnknownError(obj)
    }
}

/**
 * Anonymous class with a pre-defined error name.
 */
export interface NamedErrorConstructor {
    /**
     * See {@link ToolkitError}
     */
    new (message: string, info?: Omit<ErrorInformation, 'name'>): ToolkitError

    /**
     * See {@link ToolkitError.chain}
     */
    chain<T extends this>(
        this: T,
        error: unknown,
        message: string,
        info?: Omit<ErrorInformation, 'name' | 'cause'>
    ): InstanceType<T>
}

/**
 * Generic error class for handling exceptions within the Toolkit.
 */
export class ToolkitError extends Error implements ErrorInformation {
    /**
     * A message that could potentially be shown to the user. This should not contain any
     * sensitive information and should be limited in technical detail.
     */
    public override readonly message: string
    public readonly code = this.info.code
    public readonly details = this.info.details

    /**
     * We guard against mutation to stop a developer from creating a circular chain of errors.
     * The alternative is to truncate errors to an arbitrary depth though that doesn't address
     * why the error chain is deep.
     */
    readonly #cause = this.info.cause
    readonly #name = this.info.name ?? super.name

    public constructor(
        message: string,
        protected readonly info: ErrorInformation = {}
    ) {
        super(message)
        this.message = message
    }

    /**
     * The original error that caused this error (if any).
     */
    public get cause(): Error | undefined {
        return this.#cause
    }

    /**
     * The name of the error. This is not necessarily the same as the class name.
     */
    public override get name(): string {
        return this.#name
    }

    /**
     * See {@link ErrorInformation.cancelled cancelled}.
     *
     * Whether or not an error is considered 'cancelled' is determined either by explicit
     * assignment on construction or by finding a 'cancelled' error within its causal chain.
     */
    public get cancelled(): boolean {
        return this.info.cancelled ?? isUserCancelledError(this.cause)
    }

    /**
     * The associated documentation, if it exists. Otherwise undefined.
     */
    public get documentationUri(): vscode.Uri | undefined {
        return this.info.documentationUri
    }

    /**
     * A formatted string that is analogous to a stack trace. While stack traces enumerate every
     * call site, this trace enumerates every throw site.
     *
     * The motivation here is that stack traces are often not very useful to anyone but the original
     * developers. This is especially true for JavaScript where source maps are needed to parse traces
     * from bundled applications. We want a trace that is informative but not excessively noisy.
     */
    public get trace(): string {
        const message = formatError(this)

        if (!this.cause) {
            return message
        }

        // Stack overflows are only possible if `cause` is changed after instantiation
        const residual = this.cause instanceof ToolkitError ? this.cause.trace : formatError(this.cause)

        return `${message}\n\t -> ${residual}`
    }

    /**
     * Creates a new {@link ToolkitError} instance that was directly caused by another {@link error}.
     */
    public static chain(error: unknown, message: string, info?: Omit<ErrorInformation, 'cause'>): ToolkitError {
        return new this(message, {
            ...info,
            cause: UnknownError.cast(error),
        })
    }

    /**
     * Creates a new {@link ToolkitError} _class_ with a constant name.
     *
     * Constructor (class) names are not preserved when bundling due to name mangling. Extending off
     * this new anonymous class will ensure that the specified name is always present.
     */
    public static named(name: string): NamedErrorConstructor {
        return class extends ToolkitError {
            public override get name() {
                return name
            }

            // TypeScript does not allow the use of `this` types for generic prototype methods unfortunately
            // This implementation is equivalent to re-assignment i.e. an unbound method on the prototype
            public static override chain<
                T extends new (...args: ConstructorParameters<NamedErrorConstructor>) => ToolkitError,
            >(this: T, ...args: Parameters<NamedErrorConstructor['chain']>): InstanceType<T> {
                return ToolkitError.chain.call(this, ...args) as InstanceType<T>
            }
        }
    }
}

export function getErrorMsg(err: Error | undefined): string | undefined {
    if (err === undefined) {
        return undefined
    }

    // Non-standard SDK fields added by the OIDC service, to conform to the OAuth spec
    // (https://datatracker.ietf.org/doc/html/rfc6749#section-4.1.2.1) :
    // - error: code per the OAuth spec
    // - error_description: improved error message provided by OIDC service. Prefer this to
    //   `message` if present.
    //   https://github.com/aws/aws-toolkit-jetbrains/commit/cc9ed87fa9391dd39ac05cbf99b4437112fa3d10
    // - error_uri: not provided by OIDC currently?
    //
    // Example:
    //
    //      [error] API response (oidc.us-east-1.amazonaws.com /token): {
    //        name: 'InvalidGrantException',
    //        '$fault': 'client',
    //        '$metadata': {
    //          httpStatusCode: 400,
    //          requestId: '7f5af448-5af7-45f2-8e47-5808deaea4ab',
    //          extendedRequestId: undefined,
    //          cfId: undefined
    //        },
    //        error: 'invalid_grant',
    //        error_description: 'Invalid refresh token provided',
    //        message: 'UnknownError'
    //      }
    const anyDesc = (err as any).error_description
    const errDesc = typeof anyDesc === 'string' ? anyDesc.trim() : ''
    const msg = errDesc !== '' ? errDesc : err.message?.trim()

    if (typeof msg !== 'string') {
        return undefined
    }

    return msg
}

export function formatError(err: Error): string {
    const code = hasCode(err) && err.code !== err.name ? `[${err.code}]` : undefined
    const parts = [`${err.name}:`, getErrorMsg(err), code, formatDetails(err)]

    return parts.filter(isNonNullable).join(' ')
}

function formatDetails(err: Error): string | undefined {
    const details: Record<string, string | undefined> = {}

    if (err instanceof ToolkitError && err.details !== undefined) {
        for (const [k, v] of Object.entries(err.details)) {
            details[k] = String(v)
        }
    } else if (isAwsError(err)) {
        details['statusCode'] = String(err.statusCode ?? '')
        details['requestId'] = getRequestId(err)
        details['extendedRequestId'] = err.extendedRequestId
    }

    if (Object.keys(details).length === 0) {
        return
    }

    const joined = Object.entries(details)
        .filter(([_, v]) => !!v)
        .map(([k, v]) => `${k}: ${v}`)
        .join('; ')

    return `(${joined})`
}

export function getTelemetryResult(error: unknown | undefined): Result {
    if (error === undefined) {
        return 'Succeeded'
    } else if (isUserCancelledError(error)) {
        return 'Cancelled'
    }

    return 'Failed'
}

/**
 * Removes potential PII from a string, for logging/telemetry.
 *
 * Examples:
 * - "Failed to save c:/fooß/bar/baz.txt" => "Failed to save c:/xß/x/x.txt"
 * - "EPERM for dir c:/Users/user1/.aws/sso/cache/abc123.json" => "EPERM for dir c:/Users/x/.aws/sso/cache/x.json"
 */
export function scrubNames(s: string, username?: string) {
    let r = ''
    const fileExtRe = /\.[^.]{1,4}$/
    const slashdot = /^[~.]*[\/\\]*/

    /** Allowlisted filepath segments. */
    const keep = new Set<string>([
        '~',
        '.',
        '..',
        '.aws',
        'aws',
        'sso',
        'cache',
        'credentials',
        'config',
        'Users',
        'users',
        'home',
    ])

    if (username && username.length > 2) {
        s = s.replaceAll(username, 'x')
    }

    // Replace contiguous whitespace with 1 space.
    s = s.replace(/\s+/g, ' ')

    // 1. split on whitespace.
    // 2. scrub words that match username or look like filepaths.
    const words = s.split(/\s+/)
    for (const word of words) {
        const pathSegments = word.split(/[\/\\]/)
        if (pathSegments.length < 2) {
            // Not a filepath.
            r += ' ' + word
            continue
        }

        // Replace all (non-allowlisted) ASCII filepath segments with "x".
        // "/foo/bar/aws/sso/" => "/x/x/aws/sso/"
        let scrubbed = ''
        // Get the frontmatter ("/", "../", "~/", or "./").
        const start = word.trimStart().match(slashdot)?.[0] ?? ''
        const fileExt = word.trimEnd().match(fileExtRe)?.[0] ?? ''
        pathSegments[0] = pathSegments[0].trimStart().replace(slashdot, '')
        for (const seg of pathSegments) {
            if (driveLetterRegex.test(seg)) {
                scrubbed += seg
            } else if (keep.has(seg)) {
                scrubbed += '/' + seg
            } else {
                // Save the first non-ASCII (unicode) char, if any.
                const nonAscii = seg.match(/[^\p{ASCII}]/u)?.[0] ?? ''
                // Replace all chars (except [^…]) with "x" .
                const ascii = seg.replace(/[^$[\](){}:;'" ]+/g, 'x')
                scrubbed += `/${ascii}${nonAscii}`
            }
        }

        r += ` ${start.replace(/\\/g, '/')}${scrubbed.replace(/^[\/\\]+/, '')}${fileExt}`
    }

    return r.trim()
}

/**
 * Gets the (partial) error message detail for the `reasonDesc` field.
 *
 * @param err Error object, or message text
 */
export function getTelemetryReasonDesc(err: unknown | undefined): string | undefined {
    const m = typeof err === 'string' ? err : getErrorMsg(err as Error) ?? ''
    const msg = scrubNames(m, getUsername())

    // Truncate to 200 chars.
    return msg && msg.length > 0 ? msg.substring(0, 200) : undefined
}

export function getTelemetryReason(error: unknown | undefined): string | undefined {
    // Currently the `code` field is favored over the error name even though both are useful
    // for describing the reason. We're only using a single `reason` field and it's just simpler
    // to not encode more information.

    if (error === undefined) {
        return undefined
    } else if (error instanceof CancellationError) {
        return error.agent
    } else if (error instanceof ToolkitError) {
        // TODO: prefer the error.error field if present? (see comment in `getErrorMsg`)
        return getTelemetryReason(error.cause) ?? error.code ?? error.name
    } else if (error instanceof Error) {
        return (error as { code?: string }).code ?? error.name
    }

    return 'Unknown'
}

/**
 * Tries to build the most intuitive/relevant message to show to the user.
 *
 * User can see the full error chain in the logs Output channel.
 */
export function resolveErrorMessageToDisplay(error: unknown, defaultMessage: string): string {
    const mainMsg = error instanceof ToolkitError ? error.message : defaultMessage
    // Try to find the most useful/relevant error in the `cause` chain.
    const bestErr = error ? findBestErrorInChain(error as Error) : undefined
    const bestMsg = getErrorMsg(bestErr)
    return bestMsg && bestMsg !== mainMsg ? `${mainMsg}: ${bestMsg}` : mainMsg
}

/**
 * Patterns that match the value of {@link AWSError.code}
 */
const _preferredErrors: RegExp[] = [
    /^ConflictException$/,
    /^ValidationException$/,
    /^ResourceNotFoundException$/,
    /^ServiceQuotaExceededException$/,
    /^AccessDeniedException$/,
    /^InvalidPermissions$/,
    /^EPIPE$/,
    /^EPERM$/,
]

/**
 * Searches the `cause` chain (if any) for the most useful/relevant {@link AWSError} to surface to
 * the user, preferring "deeper" errors (lower-level, closer to the root cause) when all else is equal.
 *
 * These conditions determine precedence (in order):
 * - is AWSError
 * - has `error_description` field
 * - has `code` matching `preferredErrors`
 * - is filesystem error
 * - cause chain depth (the deepest error wins)
 *
 * @param error Error whose `cause` chain will be searched.
 * @param preferredErrors Error `code` field must match one of these, else it is discarded. Pass `[/./]` to match any AWSError.
 *
 * @returns Best match, or `error` if a better match is not found.
 */
export function findBestErrorInChain(error: Error, preferredErrors = _preferredErrors): Error | undefined {
    // TODO: Base Error has 'cause' in ES2022. So does our own `ToolkitError`.
    // eslint-disable-next-line @typescript-eslint/naming-convention
    let bestErr: Error & { code?: string; cause?: Error; error_description?: string } = error
    let err: typeof bestErr | undefined

    for (let i = 0; i < 100; i++) {
        err = i === 0 ? bestErr.cause : err?.cause
        if (!err) {
            break
        }

        // const bestErrCode = bestErr.code?.trim() ?? ''
        // const preferBest = ...
        const errCode = err.code?.trim() ?? ''
        const prefer =
            (errCode !== '' && preferredErrors.some(re => re.test(errCode))) ||
            // In priority order:
            isFilesystemError(err) ||
            isNoPermissionsError(err)

        if (isAwsError(err) || (prefer && !isAwsError(bestErr))) {
            if (isAwsError(err) && !isAwsError(bestErr)) {
                bestErr = err // Prefer AWSError.
                continue
            }

            const errDesc = err.error_description
            if (typeof errDesc === 'string' && errDesc.trim() !== '') {
                bestErr = err // Prefer (deepest) error with error_description.
                continue
            }

            if (!bestErr.error_description && prefer) {
                bestErr = err
            }
        }
    }

    return bestErr
}

export function isCodeWhispererStreamingServiceException(
    error: unknown
): error is CodeWhispererStreamingServiceException {
    if (error === undefined) {
        return false
    }

    return error instanceof Error && hasFault(error) && hasMetadata(error) && hasName(error)
}

function hasFault<T>(error: T): error is T & { $fault: 'client' | 'server' } {
    const fault = (error as { $fault?: unknown }).$fault
    return typeof fault === 'string' && (fault === 'client' || fault === 'server')
}

function hasMetadata<T>(error: T): error is T & Pick<CodeWhispererStreamingServiceException, '$metadata'> {
    return typeof (error as { $metadata?: unknown })?.$metadata === 'object'
}

function hasResponse<T>(error: T): error is T & Pick<ServiceException, '$response'> {
    return typeof (error as { $response?: unknown })?.$response === 'object'
}

function hasName<T>(error: T): error is T & { name: string } {
    return typeof (error as { name?: unknown })?.name === 'string'
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export function isAwsError(error: unknown): error is AWSError & { error_description?: string } {
    if (error === undefined) {
        return false
    }

    return error instanceof Error && hasCode(error) && hasTime(error)
}

function hasCode<T>(error: T): error is T & { code: string } {
    return typeof (error as { code?: unknown }).code === 'string'
}

function hasTime(error: Error): error is typeof error & { time: Date } {
    return (error as { time?: unknown }).time instanceof Date
}

export function isUserCancelledError(error: unknown): boolean {
    return CancellationError.isUserCancelled(error) || (error instanceof ToolkitError && error.cancelled)
}

/**
 * Checks if the AWS SDK v3 error was caused by the client and not due to a service issue.
 */
export function isClientFault(error: ServiceException): boolean {
    return error.$fault === 'client' && !(isThrottlingError(error) || isTransientError(error))
}

export function getRequestId(err: unknown): string | undefined {
    // XXX: Checking `err instanceof ServiceException` fails for `SSOOIDCServiceException` even
    // though it subclasses @aws-sdk/smithy-client.ServiceException
    if (typeof (err as any)?.$metadata?.requestId === 'string') {
        return (err as any).$metadata.requestId
    }

    if (isAwsError(err)) {
        return err.requestId
    }
}

export function getHttpStatusCode(err: unknown): number | undefined {
    if (hasResponse(err) && err?.$response?.statusCode !== undefined) {
        return err?.$response?.statusCode
    }
    if (hasMetadata(err) && err.$metadata?.httpStatusCode !== undefined) {
        return err.$metadata?.httpStatusCode
    }

    return undefined
}

export function isFilesystemError(err: unknown): boolean {
    if (
        err instanceof vscode.FileSystemError ||
        (hasCode(err) &&
            (err.code === 'EEXIST' ||
                err.code === 'EISDIR' ||
                err.code === 'ENOTDIR' ||
                err.code === 'EMFILE' ||
                err.code === 'ENOENT' ||
                err.code === 'ENOTEMPTY'))
    ) {
        return true
    }

    return false
}

// export function isIsDirError(err: unknown): boolean {
//     if (err instanceof vscode.FileSystemError) {
//         return err.code === vscode.FileSystemError.FileIsADirectory().code
//     } else if (hasCode(err)) {
//         return err.code === 'EISDIR'
//     }
//     return false
// }
//
// export function isFileExistsError(err: unknown): boolean {
//     if (err instanceof vscode.FileSystemError) {
//         return err.code === vscode.FileSystemError.FileExists().code
//     } else if (hasCode(err)) {
//         return err.code === 'EEXIST'
//     }
//     return false
// }

export function isFileNotFoundError(err: unknown): boolean {
    if (err instanceof vscode.FileSystemError) {
        return err.code === vscode.FileSystemError.FileNotFound().code
    } else if (hasCode(err)) {
        return err.code === 'ENOENT'
    }

    return false
}

export function isNoPermissionsError(err: unknown): boolean {
    if (err instanceof vscode.FileSystemError) {
        return (
            err.code === vscode.FileSystemError.NoPermissions().code ||
            // The code _should_ be `NoPermissions`, maybe this is a bug?
            (err.code === 'Unknown' && err.message.includes('EACCES: permission denied'))
        )
    } else if (hasCode(err)) {
        // " Some operating systems report EPERM in situations unrelated to permissions."
        // || err.code === 'EPERM'
        return err.code === 'EACCES'
    }

    return false
}

function modeToString(mode: number) {
    return Array.from('rwxrwxrwx')
        .map((c, i, a) => ((mode >> (a.length - (i + 1))) & 1 ? c : '-'))
        .join('')
}

function vscodeModeToString(mode: vscode.FileStat['permissions']) {
    // XXX: vscode.FileStat.permissions only indicates "readonly" or nothing (aka "writable").
    if (mode === undefined) {
        return 'rwx------'
    } else if (mode === vscode.FilePermission.Readonly) {
        return 'r-x------'
    }

    // XXX: future-proof in case vscode.FileStat.permissions gains more granularity.
    if (isAutomation()) {
        throw new Error('vscode.FileStat.permissions gained new fields, update this logic')
    }
}

function getEffectivePerms(uid: number, gid: number, stats: fs.Stats) {
    const mode = stats.mode
    const isOwner = uid === stats.uid
    const isGroup = gid === stats.gid && !isOwner

    // Many unix systems support multiple groups but we only know the primary
    // The user can still have group permissions despite not having the same `gid`
    // These situations are ambiguous, so the effective permissions are the
    // intersection of the two bitfields
    if (!isOwner && !isGroup) {
        return {
            isAmbiguous: true,
            effective: mode & 0o007 & ((mode & 0o070) >> 3),
        }
    }

    const ownerMask = isOwner ? 0o700 : 0
    const groupMask = isGroup ? 0o070 : 0

    return {
        isAmbiguous: false,
        effective: ((mode & groupMask) >> 3) | ((mode & ownerMask) >> 6),
    }
}

// The wildcard (`*`) symbol is non-standard. It's used to represent "don't cares" and takes
// on the actual flag once known.
export type PermissionsTriplet = `${'r' | '-' | '*'}${'w' | '-' | '*'}${'x' | '-' | '*'}`
export class PermissionsError extends ToolkitError {
    public readonly actual: string // This is a resolved triplet, _not_ the full bits

    static fromNodeFileStats(stats: fs.Stats, userInfo: os.UserInfo<string>, expected: string, source: unknown) {
        const mode = `${stats.isDirectory() ? 'd' : '-'}${modeToString(stats.mode)}`
        const owner = stats.uid === userInfo.uid ? (stats.uid === -1 ? '' : userInfo.username) : String(stats.uid)
        const group = String(stats.gid)
        const { effective, isAmbiguous } = getEffectivePerms(userInfo.uid, userInfo.gid, stats)
        const actual = modeToString(effective).slice(-3)
        const isOwner = stats.uid === -1 ? 'unknown' : userInfo.uid === stats.uid

        return { mode, owner, group, actual, isAmbiguous, isOwner }
    }

    static fromVscodeFileStats(
        stats: vscode.FileStat,
        userInfo: os.UserInfo<string>,
        expected: string,
        source: unknown
    ) {
        const isDir = !!(stats.type & vscode.FileType.Directory)
        const mode = `${isDir ? 'd' : '-'}${vscodeModeToString(stats.permissions)}`
        const owner = '' // vscode.FileStat does not currently provide file owner.
        const group = '' // vscode.FileStat does not currently provide file group.
        const isAmbiguous = true // vscode.workspace.fs.stat() is currently always ambiguous.
        const actual = mode
        const isOwner = 'unknown' // vscode.FileStat does not currently provide file owner.

        return { mode, owner, group, actual, isAmbiguous, isOwner }
    }

    /**
     * Creates a PermissionsError from a file stat() result.
     *
     * Note: pass `fs.Stats` when possible (in a nodejs context), because it gives much better info.
     */
    public constructor(
        public readonly uri: vscode.Uri,
        public readonly stats: fs.Stats | vscode.FileStat,
        public readonly userInfo: os.UserInfo<string>,
        public readonly expected: PermissionsTriplet,
        source?: unknown
    ) {
        const o = (stats as any).type
            ? PermissionsError.fromVscodeFileStats(stats as vscode.FileStat, userInfo, expected, source)
            : PermissionsError.fromNodeFileStats(stats as fs.Stats, userInfo, expected, source)

        const resolvedExpected = Array.from(expected)
            .map((c, i) => (c === '*' ? o.actual[i] : c))
            .join('')
        const actualText = !o.isAmbiguous ? o.actual : `${o.mode.slice(-6, -3)} & ${o.mode.slice(-3)} (ambiguous)`

        // Guard against surfacing confusing error messages. If the actual perms equal the resolved
        // perms then odds are it wasn't really a permissions error. Some operating systems report EPERM
        // in situations that aren't related to permissions at all.
        if (o.actual === resolvedExpected && !o.isAmbiguous && source !== undefined) {
            throw source
        }

        super(`${uri.fsPath} has incorrect permissions. Expected ${resolvedExpected}, found ${actualText}.`, {
            code: 'InvalidPermissions',
            details: {
                isOwner: o.isOwner,
                mode: `${o.mode}${o.owner === '' ? '' : ` ${o.owner}`}${o.group === '' ? '' : ` ${o.group}`}`,
            },
        })

        this.actual = o.actual
    }
}

export function isNetworkError(err?: unknown): err is Error & { code: string } {
    if (isVSCodeProxyError(err)) {
        return true
    }

    if (!hasCode(err)) {
        return false
    }

    return [
        'ENOTFOUND',
        'EAI_AGAIN',
        'ECONNRESET',
        'ECONNREFUSED',
        'ETIMEDOUT',
        'ENETUNREACH',
        'ERR_TLS_CERT_ALTNAME_INVALID', // dns issue?
        'EPROTO', // due to legacy server "unsafe legacy renegotiation"?
        'EHOSTUNREACH',
        'EADDRINUSE',
        'ENOBUFS', // client side memory issue during http request?
        'EADDRNOTAVAIL', // port not available/allowed?
    ].includes(err.code)
}

/**
 * This error occurs on a network call if the user has set up a proxy in the
 * VS Code settings but the proxy is not reachable.
 *
 * Setting ID: http.proxy
 */
function isVSCodeProxyError(err?: unknown): boolean {
    if (!(err instanceof Error)) {
        return false
    }

    return err.name === 'Error' && err.message.startsWith('Failed to establish a socket connection to proxies')
}
