/**
 * The request header middleware uses to hand the console layout the path it is
 * rendering (#262).
 *
 * A Next.js server layout receives no pathname — there is no prop for it and
 * no API to read one — so the capability gate has no other way to learn which
 * surface a request is for. Middleware sets it on the REQUEST headers, so it
 * travels into the render and is never sent to the browser.
 *
 * Its own module so the setter and the reader import one constant. A string
 * literal spelled twice is the kind of drift that fails open here: the layout
 * would read `undefined`, resolve to the entry capability, and quietly stop
 * gating anything — which looks exactly like everything working.
 */
export const CONSOLE_PATHNAME_HEADER = "x-console-pathname";
