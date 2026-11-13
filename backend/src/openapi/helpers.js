// Helpers pour la rédaction des fragments OpenAPI 3.1.

const AUTH_ANY = [{ bearerAuth: [] }, { apiKeyAuth: [] }];
const AUTH_SESSION = [{ bearerAuth: [] }];
const AUTH_PUBLIC = [];

const errRef = { $ref: '#/components/schemas/Error' };

function jsonContent(schema, example) {
  const out = { schema };
  if (example !== undefined) out.example = example;
  return { 'application/json': out };
}

function jsonBody(schema, { required = true, description, example } = {}) {
  return {
    required,
    ...(description ? { description } : {}),
    content: jsonContent(schema, example),
  };
}

function multipartBody(schema, description) {
  return {
    required: true,
    ...(description ? { description } : {}),
    content: {
      'multipart/form-data': { schema },
    },
  };
}

function jsonResp(description, schema = { type: 'object' }, example) {
  return { description, content: jsonContent(schema, example) };
}

function okResp(description = 'Opération réussie') {
  return jsonResp(description, {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
  }, { ok: true });
}

function errResp(description) {
  return { description, content: { 'application/json': { schema: errRef } } };
}

function pathParam(name, description, example) {
  return {
    name,
    in: 'path',
    required: true,
    description,
    schema: { type: 'string', ...(example ? { example } : {}) },
  };
}

function queryParam(name, description, schema = { type: 'string' }, required = false) {
  return {
    name,
    in: 'query',
    required,
    description,
    schema,
  };
}

const stdAuthErrors = {
  401: errResp('Authentification manquante, invalide ou expirée'),
  403: errResp('Permission refusée ou clé API en lecture seule'),
};

module.exports = {
  AUTH_ANY,
  AUTH_SESSION,
  AUTH_PUBLIC,
  jsonContent,
  jsonBody,
  multipartBody,
  jsonResp,
  okResp,
  errResp,
  pathParam,
  queryParam,
  stdAuthErrors,
};
