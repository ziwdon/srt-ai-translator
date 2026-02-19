const basicAuth = async (request, context) => {
  const username = Netlify.env.get("BASIC_AUTH_USER");
  const password = Netlify.env.get("BASIC_AUTH_PASS");

  // If env vars are not set, do not block access.
  if (!username || !password) {
    return context.next();
  }

  const unauthorized = () =>
    new Response("Unauthorized", {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Basic realm="Protected", charset="UTF-8"',
      },
    });

  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Basic ")) {
    return unauthorized();
  }

  try {
    const base64Credentials = authHeader.slice("Basic ".length).trim();
    const decoded = atob(base64Credentials);
    const separatorIndex = decoded.indexOf(":");
    if (separatorIndex === -1) {
      return unauthorized();
    }

    const providedUser = decoded.slice(0, separatorIndex);
    const providedPass = decoded.slice(separatorIndex + 1);

    if (providedUser === username && providedPass === password) {
      return context.next();
    }
  } catch {
    return unauthorized();
  }

  return unauthorized();
};

export default basicAuth;

