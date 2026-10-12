import type { LoaderFunctionArgs } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";
import { Button, Card, Page, Text, TextField } from "@shopify/polaris";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { useState } from "react";
import { login } from "../../shopify.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return {
    showForm: Boolean(login),
    shop: new URL(request.url).searchParams.get("shop") ?? "",
  };
};

export default function Index() {
  const { showForm, shop: initialShop } = useLoaderData<typeof loader>();
  const [shop, setShop] = useState(initialShop);

  return (
    <Page>
      <Card>
        <Form method="post" action="/auth/login">
          <div style={{ display: "grid", gap: "1rem" }}>
            <Text as="h1" variant="headingLg">
              PricePilot
            </Text>
            <Text as="p" variant="bodyMd">
              Sign in to open your embedded pricing workspace in Shopify Admin.
            </Text>
            {showForm && (
              <TextField
                label="Shop domain"
                name="shop"
                value={shop}
                onChange={setShop}
                autoComplete="on"
                helpText="example.myshopify.com"
              />
            )}
            {showForm && (
              <Button submit variant="primary">
                Log in
              </Button>
            )}
          </div>
        </Form>
      </Card>
    </Page>
  );
}
