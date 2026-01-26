import { html } from "lit";

// Import the landing page component
import "../landing/index";

export type LandingProps = {
  onGetStarted: () => void;
  onBookDemo: () => void;
};

export function renderLanding(props: LandingProps) {
  return html`
    <landing-page
      @get-started=${props.onGetStarted}
      @book-demo=${props.onBookDemo}
    ></landing-page>
  `;
}
