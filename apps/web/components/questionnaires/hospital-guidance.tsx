export function HospitalGuidance({ compact = false }: { compact?: boolean }) {
  return (
    <section
      id={compact ? undefined : "hospital-food"}
      className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm leading-6 text-stone-800"
    >
      <h2 className="text-lg font-semibold">
        Hospital food needs a separate approval check
      </h2>
      <p>
        This survey is for retail planning. Patient meals, prescribed diets and
        clinical nutrition need the hospital’s clinical food-service approval.
        Do not share patient details or medical conditions.
      </p>
      <details open={!compact} className="mt-3">
        <summary className="cursor-pointer font-medium">
          What could be considered, and what should be held back?
        </summary>
        <ul className="mt-3 list-disc space-y-2 pl-5">
          <li>
            Consider appropriately labelled, traceable products from approved
            suppliers, such as sealed water and suitable portioned snacks. The
            hospital still needs to approve the exact products, placement and
            nutrition criteria.
          </li>
          <li>
            Fresh juice, yoghurt, lassi, shakes, cut fruit, sandwiches and
            prepared regional dishes require an assessed storage and servicing
            model. Hot drinks and meals need suitable equipment and burn-risk
            controls. Product recipes and manufacturer instructions determine
            actual handling.
          </li>
          <li>
            Do not stock unsafe, recalled, untraceable or improperly labelled
            food, or food past applicable expiry/use-by limits. Hold any product
            the hospital prohibits. Review allergens, caffeine/energy drinks,
            high-sugar drinks, salty snacks, glass containers and access by
            children with the policy owner.
          </li>
          <li>
            For India, confirm the applicable FSSAI registration/licence,
            food-safety controls and hospital procurement rules. Eat Right
            Campus is a useful framework; it is not permission to sell every
            listed item.
          </li>
          <li>
            Victorian public health services apply Healthy Choices requirements
            to all vending, including no RED-classified drinks. This is
            jurisdiction-specific: exact product classification and hospital
            policy matter.
          </li>
        </ul>
        <p className="mt-3">
          Source guidance:{" "}
          <a
            className="underline"
            href="https://eastregion.fssai.gov.in/Eat-Right-Campus.php"
            target="_blank"
            rel="noreferrer"
          >
            FSSAI Eat Right Campus
          </a>
          ;{" "}
          <a
            className="underline"
            href="https://www.health.vic.gov.au/publications/healthy-choices-policy-directive-and-guidelines-for-health-services"
            target="_blank"
            rel="noreferrer"
          >
            Victoria Healthy Choices
          </a>
          ;{" "}
          <a
            className="underline"
            href="https://www.england.nhs.uk/publication/national-standards-for-healthcare-food-and-drink/"
            target="_blank"
            rel="noreferrer"
          >
            NHS England food standards
          </a>
          .
        </p>
      </details>
    </section>
  );
}
