import { Button } from "../../../../design-system/button";

// One answer for a Project, Plan or Session that does not exist and for one
// the User cannot read, so the page never reveals which it is.
export default function NotFound() {
  return (
    <div className="app-message">
      <h1>Not found</h1>
      <p>This page does not exist, or you do not have access to it.</p>
      <p>
        <Button href="/">Back to your Projects</Button>
      </p>
    </div>
  );
}
