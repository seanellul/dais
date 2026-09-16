import { PageHeader } from "@/ui";
import { AuthForm } from "@/organiser/auth-form";
export default function Page() {
  return (
    <>
      <PageHeader
        title="Your first tournament starts here"
        subtitle="Create the organisation and its first owner."
      />
      <AuthForm mode="setup" />
    </>
  );
}
