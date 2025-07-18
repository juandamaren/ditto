import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { renderLiquid } from "backend-lib/src/liquid";
import logger from "backend-lib/src/logger";
import {
  sendMessage,
  upsertMessageTemplate,
} from "backend-lib/src/messageTemplates";
import prisma from "backend-lib/src/prisma";
import { Prisma } from "backend-lib/src/types";
import { FastifyInstance } from "fastify";
import { CHANNEL_IDENTIFIERS } from "isomorphic-lib/src/channels";
import { SUBSCRIPTION_SECRET_NAME } from "isomorphic-lib/src/constants";
import {
  BadWorkspaceConfigurationType,
  ChannelType,
  DeleteMessageTemplateRequest,
  EmailProviderType,
  EmptyResponse,
  InternalEventType,
  JsonResultType,
  MessageSkippedType,
  MessageTemplateResource,
  MessageTemplateTestRequest,
  MessageTemplateTestResponse,
  RenderMessageTemplateRequest,
  RenderMessageTemplateResponse,
  RenderMessageTemplateResponseContent,
  UpsertMessageTemplateResource,
} from "isomorphic-lib/src/types";
import * as R from "remeda";

// eslint-disable-next-line @typescript-eslint/require-await
export default async function contentController(fastify: FastifyInstance) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().post(
    "/templates/render",
    {
      schema: {
        description: "Render message template.",
        body: RenderMessageTemplateRequest,
        response: {
          200: RenderMessageTemplateResponse,
        },
      },
    },
    async (request, reply) => {
      const {
        contents,
        workspaceId,
        subscriptionGroupId,
        channel,
        userProperties,
      } = request.body;

      const secrets = await prisma().secret.findMany({
        where: {
          workspaceId,
          name: {
            in: [SUBSCRIPTION_SECRET_NAME],
          },
        },
      });

      const templateSecrets: Record<string, string> = {};
      for (const secret of secrets) {
        if (!secret.value) {
          continue;
        }
        templateSecrets[secret.name] = secret.value;
      }

      const identifierKey = CHANNEL_IDENTIFIERS[channel];

      const responseContents: RenderMessageTemplateResponse["contents"] =
        R.mapValues(contents, (content) => {
          let value: RenderMessageTemplateResponseContent;
          try {
            const rendered = renderLiquid({
              workspaceId,
              template: content.value,
              mjml: content.mjml,
              subscriptionGroupId,
              userProperties,
              identifierKey,
              secrets: templateSecrets,
            });
            value = {
              type: JsonResultType.Ok,
              value: rendered,
            };
          } catch (e) {
            const err = e as Error;
            value = {
              type: JsonResultType.Err,
              err: err.message,
            };
          }
          return value;
        });

      return reply.status(200).send({
        contents: responseContents,
      });
    }
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().put(
    "/templates",
    {
      schema: {
        description: "Create or update message template",
        body: UpsertMessageTemplateResource,
        response: {
          200: MessageTemplateResource,
        },
      },
    },
    async (request, reply) => {
      const resource = await upsertMessageTemplate(request.body);
      return reply.status(200).send(resource);
    }
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().post(
    "/templates/test",
    {
      schema: {
        description: "Send a test message for a message template.",
        body: MessageTemplateTestRequest,
        response: {
          200: MessageTemplateTestResponse,
        },
      },
    },
    async (request, reply) => {
      const result = await sendMessage({
        workspaceId: request.body.workspaceId,
        templateId: request.body.templateId,
        userPropertyAssignments: request.body.userProperties,
        channel: request.body.channel,
        useDraft: true,
      });
      if (result.isOk()) {
        return reply.status(200).send({
          type: JsonResultType.Ok,
          value: result.value,
        });
      }
      if (
        result.error.type === InternalEventType.MessageSkipped &&
        result.error.variant.type === MessageSkippedType.MissingIdentifier
      ) {
        return reply.status(200).send({
          type: JsonResultType.Err,
          err: {
            suggestions: [
              `Missing identifying user property value: ${result.error.variant.identifierKey}`,
            ],
          },
        });
      }
      if (result.error.type === InternalEventType.MessageFailure) {
        if (
          result.error.variant.type === ChannelType.Email &&
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          result.error.variant.provider.type === EmailProviderType.Sendgrid
        ) {
          const { body, status } = result.error.variant.provider;
          const suggestions: string[] = [];
          if (status) {
            suggestions.push(`Sendgrid responded with status: ${status}`);
            if (status === 403) {
              suggestions.push(
                "Is the configured email domain authorized in sengrid?"
              );
            }
          }
          return reply.status(200).send({
            type: JsonResultType.Err,
            err: {
              suggestions,
              responseData: body,
            },
          });
        }
      }
      if (result.error.type === InternalEventType.BadWorkspaceConfiguration) {
        if (
          result.error.variant.type ===
          BadWorkspaceConfigurationType.MessageServiceProviderMisconfigured
        ) {
          return reply.status(200).send({
            type: JsonResultType.Err,
            err: {
              suggestions: [
                [
                  "Unable to send message, because your message service provider is not configured correctly",
                  result.error.variant.message,
                ].join(" - "),
              ],
            },
          });
        }

        if (
          result.error.variant.type ===
          BadWorkspaceConfigurationType.MessageServiceProviderNotFound
        ) {
          return reply.status(200).send({
            type: JsonResultType.Err,
            err: {
              suggestions: [
                `Unable to send message, because you haven't configured a message service provider.`,
              ],
            },
          });
        }
      }
      logger().error(result.error, "Unexpected error sending test message");
      return reply.status(500);
    }
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().delete(
    "/templates",
    {
      schema: {
        description: "Delete a message template.",
        body: DeleteMessageTemplateRequest,
        response: {
          204: EmptyResponse,
          404: {},
        },
      },
    },
    async (request, reply) => {
      const { id } = request.body;

      try {
        await prisma().messageTemplate.delete({
          where: {
            id,
          },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError) {
          switch (e.code) {
            case "P2025":
              return reply.status(404).send();
            case "P2023":
              return reply.status(404).send();
          }
        }
        throw e;
      }

      return reply.status(204).send();
    }
  );
}
