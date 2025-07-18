import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import prisma, { Prisma } from "backend-lib/src/prisma";
import { UserProperty } from "backend-lib/src/types";
import { FastifyInstance } from "fastify";
import protectedUserProperties from "isomorphic-lib/src/protectedUserProperties";
import { schemaValidate } from "isomorphic-lib/src/resultHandling/schemaValidation";
import {
  DeleteUserPropertyRequest,
  EmptyResponse,
  UpsertUserPropertyResource,
  UserPropertyDefinition,
  UserPropertyResource,
} from "isomorphic-lib/src/types";

// eslint-disable-next-line @typescript-eslint/require-await
export default async function userPropertiesController(
  fastify: FastifyInstance
) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().put(
    "/",
    {
      schema: {
        description: "Create or update a user property.",

        body: UpsertUserPropertyResource,
        response: {
          200: UserPropertyResource,
        },
      },
    },
    async (request, reply) => {
      let userProperty: UserProperty;
      const { id, name, definition, workspaceId } = request.body;

      const canCreate = workspaceId && name && definition;
      const definitionUpdatedAt = definition ? new Date() : undefined;

      if (protectedUserProperties.has(name)) {
        return reply.status(400).send();
      }

      if (canCreate && id) {
        userProperty = await prisma().userProperty.upsert({
          where: {
            id,
          },
          create: {
            id,
            workspaceId,
            name,
            definition,
          },
          update: {
            workspaceId,
            name,
            definition,
            definitionUpdatedAt,
          },
        });
      } else {
        userProperty = await prisma().userProperty.update({
          where: {
            id,
          },
          data: {
            workspaceId,
            name,
            definition,
            definitionUpdatedAt,
          },
        });
      }

      const userPropertyDefinitionResult = schemaValidate(
        userProperty.definition,
        UserPropertyDefinition
      );

      if (userPropertyDefinitionResult.isErr()) {
        // TODO add logging
        return reply.status(500).send();
      }
      const resource: UserPropertyResource = {
        id: userProperty.id,
        name: userProperty.name,
        workspaceId: userProperty.workspaceId,
        definition: userPropertyDefinitionResult.value,
      };

      return reply.status(200).send(resource);
    }
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().delete(
    "/",
    {
      schema: {
        description: "Delete a user property.",
        body: DeleteUserPropertyRequest,
        response: {
          204: EmptyResponse,
          404: {},
        },
      },
    },
    async (request, reply) => {
      const { id } = request.body;

      let deletedCount: number;
      try {
        await prisma().userPropertyAssignment.deleteMany({
          where: {
            AND: [
              {
                userPropertyId: id,
              },
              {
                userProperty: {
                  name: {
                    notIn: Array.from(protectedUserProperties),
                  },
                },
              },
            ],
          },
        });
        const response = await prisma().userProperty.deleteMany({
          where: {
            AND: [
              {
                id,
              },
              {
                name: {
                  notIn: Array.from(protectedUserProperties),
                },
              },
            ],
          },
        });
        deletedCount = response.count;
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

      if (deletedCount <= 0) {
        return reply.status(404).send();
      }

      return reply.status(204).send();
    }
  );
}
