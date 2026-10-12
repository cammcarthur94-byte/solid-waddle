import { BlockStack, Card, Page, Text } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";

export default function HelpPage() {
  return (
    <Page>
      <TitleBar title="PricePilot" />
      <Card>
        <BlockStack gap="200">
          <Text as="h2" variant="headingMd">
            PricePilot workspace
          </Text>
          <Text as="p" variant="bodyMd">
            Use the app navigation to explore your dashboard, campaigns, activity logs, and store settings.
          </Text>
        </BlockStack>
      </Card>
    </Page>
  );
}
