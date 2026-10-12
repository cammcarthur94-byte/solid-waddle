import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Badge, Card, IndexTable, Page, Text } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const entries = await prisma.activityLog.findMany({
    where: { shop: { shopDomain: session.shop } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 100,
    select: {
      id: true,
      action: true,
      message: true,
      createdAt: true,
    },
  });

  return json({
    entries: entries.map((entry) => ({
      ...entry,
      createdAt: entry.createdAt.toISOString(),
    })),
  });
};

export default function ActivityLogs() {
  const { entries } = useLoaderData<typeof loader>();

  return (
    <Page>
      <TitleBar title="Activity Logs" />
      <Card padding="0">
        <IndexTable
          resourceName={{ singular: "activity", plural: "activities" }}
          itemCount={entries.length}
          headings={[
            { title: "Time" },
            { title: "Event" },
            { title: "Details" },
          ]}
          emptyState={
            <div style={{ padding: "1.5rem" }}>
              <Text as="p" variant="bodyMd" tone="subdued">
                Campaign activity will appear here when campaigns are scheduled or processed.
              </Text>
            </div>
          }
        >
          {entries.map((entry, index) => (
            <IndexTable.Row id={entry.id} key={entry.id} position={index}>
              <IndexTable.Cell>
                <Text as="span" variant="bodySm">
                  {new Intl.DateTimeFormat(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }).format(new Date(entry.createdAt))}
                </Text>
              </IndexTable.Cell>
              <IndexTable.Cell>
                <Badge>{entry.action.replaceAll("_", " ")}</Badge>
              </IndexTable.Cell>
              <IndexTable.Cell>
                <Text as="span" variant="bodyMd">
                  {entry.message}
                </Text>
              </IndexTable.Cell>
            </IndexTable.Row>
          ))}
        </IndexTable>
      </Card>
    </Page>
  );
}
