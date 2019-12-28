import { camel, pascal } from 'case';
import get from 'lodash/get';
import groupBy from 'lodash/groupBy';
import uniq from 'lodash/uniq';
import {
  ComponentsObject,
  OpenAPIObject,
  OperationObject,
  ParameterObject,
  PathItemObject,
  ReferenceObject,
  ResponseObject,
} from 'openapi3-ts';
import { generalJSTypes } from '../constants/generalJsTypes';
import { getParamsInPath } from '../utils/getParamsInPath';
import { getParamsTypes } from '../utils/getParamsTypes';
import { getQueryParamsTypes } from '../utils/getQueryParamsTypes';
import { getResReqTypes } from '../utils/getResReqTypes';
import { isReference } from '../utils/isReference';

/**
 * Generate a restful-client component from openapi operation specs
 *
 * @param operation
 * @param verb
 * @param route
 * @param baseUrl
 * @param operationIds - List of `operationId` to check duplication
 */
const generateApiCalls = (
  operation: OperationObject,
  verb: string,
  route: string,
  operationIds: string[],
  parameters: Array<ReferenceObject | ParameterObject> = [],
  schemasComponents?: ComponentsObject,
) => {
  if (!operation.operationId) {
    throw new Error(`Every path must have a operationId - No operationId set for ${verb} ${route}`);
  }
  if (operationIds.includes(operation.operationId)) {
    throw new Error(`"${operation.operationId}" is duplicated in your schema definition!`);
  }
  let output = '';
  operationIds.push(operation.operationId);

  route = route.replace(/\{/g, '${'); // `/pet/{id}` => `/pet/${id}`

  // Remove the last param of the route if we are in the DELETE case
  let lastParamInTheRoute: string | null = null;
  if (verb === 'delete') {
    const lastParamInTheRouteRegExp = /\/\$\{(\w+)\}$/;
    lastParamInTheRoute = (route.match(lastParamInTheRouteRegExp) || [])[1];
    route = route.replace(lastParamInTheRouteRegExp, ''); // `/pet/${id}` => `/pet`
  }
  const componentName = pascal(operation.operationId!);

  const isOk = ([statusCode]: [string, ResponseObject | ReferenceObject]) => statusCode.toString().startsWith('2');

  const responseTypes = getResReqTypes(Object.entries(operation.responses).filter(isOk));

  const requestBodyTypes = getResReqTypes([['body', operation.requestBody!]]);
  const needAResponseComponent = responseTypes.includes('{');

  const paramsInPath = getParamsInPath(route).filter(param => !(verb === 'delete' && param === lastParamInTheRoute));
  const { query: queryParams = [], path: pathParams = [] } = groupBy(
    [...parameters, ...(operation.parameters || [])].map<ParameterObject>(p => {
      if (isReference(p)) {
        return get(schemasComponents, p.$ref.replace('#/components/', '').replace('/', '.'));
      } else {
        return p;
      }
    }),
    'in',
  );

  const propsDefinition = [
    ...getParamsTypes({ params: paramsInPath, pathParams, operation }),
    ...(requestBodyTypes
      ? [{ definition: `${camel(requestBodyTypes)}: ${requestBodyTypes}`, default: false, required: false }]
      : []),
    ...(queryParams.length
      ? [
          {
            definition: `params?: { ${getQueryParamsTypes({ queryParams })
              .map(({ definition }) => definition)
              .join(', ')} }`,
            default: false,
            required: false,
          },
        ]
      : []),
  ]
    .sort((a, b) => {
      if (a.default) {
        return 1;
      }

      if (b.default) {
        return -1;
      }

      if (a.required && b.required) {
        return 1;
      }

      if (a.required) {
        return -1;
      }

      if (b.required) {
        return 1;
      }
      return 1;
    })
    .map(({ definition }) => definition)
    .join(', ');

  const props = [
    ...getParamsTypes({ params: paramsInPath, pathParams, operation, type: 'implementation' }),
    ...(requestBodyTypes
      ? [{ definition: `${camel(requestBodyTypes)}: ${requestBodyTypes}`, default: false, required: false }]
      : []),
    ...(queryParams.length
      ? [
          {
            definition: `params?: { ${getQueryParamsTypes({ queryParams, type: 'implementation' })
              .map(({ definition }) => definition)
              .join(', ')} }`,
            default: false,
            required: false,
          },
        ]
      : []),
  ]
    .sort((a, b) => {
      if (a.default) {
        return 1;
      }

      if (b.default) {
        return -1;
      }

      if (a.required && b.required) {
        return 1;
      }

      if (a.required) {
        return -1;
      }

      if (b.required) {
        return 1;
      }
      return 1;
    })
    .map(({ definition }) => definition)
    .join(', ');

  const definition = `
  ${operation.summary ? '// ' + operation.summary : ''}
  ${camel(componentName)}(${propsDefinition}): AxiosPromise<${
    needAResponseComponent ? componentName + 'Response' : responseTypes
  }>`;

  output = `  ${camel(componentName)}(${props}): AxiosPromise<${
    needAResponseComponent ? componentName + 'Response' : responseTypes
  }> {
    return axios.${verb}(\`${route}\` ${requestBodyTypes ? `, ${camel(requestBodyTypes)}` : ''} ${
    queryParams.length || responseTypes === 'BlobPart'
      ? `,
      {
        ${queryParams.length ? 'params' : ''}${queryParams.length && responseTypes === 'BlobPart' ? ',' : ''}${
          responseTypes === 'BlobPart'
            ? `responseType: 'arraybuffer',
        headers: {
          Accept: 'application/pdf',
        },`
            : ''
        }
      }`
      : ''
  });
  },
`;

  return { value: output, definition, imports: [responseTypes, requestBodyTypes] };
};

export const generateApi = (specs: OpenAPIObject, operationIds: string[]) => {
  let imports: string[] = [];
  let definition = '';
  definition += `export interface ${pascal(specs.info.title)} {`;
  let value = '';
  value += `export const get${pascal(specs.info.title)} = (axios: AxiosInstance): ${pascal(specs.info.title)} => ({\n`;
  Object.entries(specs.paths).forEach(([route, verbs]: [string, PathItemObject]) => {
    Object.entries(verbs).forEach(([verb, operation]: [string, OperationObject]) => {
      if (['get', 'post', 'patch', 'put', 'delete'].includes(verb)) {
        const call = generateApiCalls(operation, verb, route, operationIds, verbs.parameters, specs.components);
        imports = [...imports, ...call.imports];
        definition += `${call.definition};`;
        value += call.value;
      }
    });
  });
  definition += '\n};';
  value += '})';

  return {
    output: `${definition}\n\n${value}`,
    imports: uniq(imports.filter(imp => imp && !generalJSTypes.includes(imp.toLocaleLowerCase()))),
  };
};
