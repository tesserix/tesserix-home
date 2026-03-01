"use client";

import { useState } from "react";
import { Mail, MapPin, Phone, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AnimateOnScroll } from "@/components/ui/animate-on-scroll";

const contactInfo = [
  {
    icon: Mail,
    title: "Email",
    description: "sales@tesserix.app",
    href: "mailto:sales@tesserix.app",
  },
  {
    icon: Phone,
    title: "Phone",
    description: "+1 (555) 123-4567",
    href: "tel:+15551234567",
  },
  {
    icon: MapPin,
    title: "Office",
    description: "San Francisco, CA",
    href: null,
  },
];

export default function ContactPage() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validateForm = (formData: FormData) => {
    const newErrors: Record<string, string> = {};
    const email = formData.get("email") as string;
    const firstName = formData.get("firstName") as string;
    const message = formData.get("message") as string;

    if (!firstName?.trim()) {
      newErrors.firstName = "First name is required";
    }
    if (!email?.trim()) {
      newErrors.email = "Email is required";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      newErrors.email = "Please enter a valid email address";
    }
    if (!message?.trim()) {
      newErrors.message = "Message is required";
    }

    return newErrors;
  };

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const validationErrors = validateForm(formData);

    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }

    setErrors({});
    setIsSubmitting(true);

    // Simulate form submission
    await new Promise((resolve) => setTimeout(resolve, 1500));

    setIsSubmitting(false);
    setSubmitted(true);
  }

  return (
    <div>
      {/* Hero */}
      <section className="py-12 sm:py-16">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <AnimateOnScroll variant="fade-up" className="mx-auto max-w-2xl text-center">
            <h1 className="text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
              Get in Touch
            </h1>
            <p className="mt-6 text-lg leading-relaxed text-muted-foreground">
              Have questions about our products? Want to schedule a demo?
              Our team is here to help.
            </p>
          </AnimateOnScroll>
        </div>
      </section>

      {/* Contact Form & Info */}
      <section className="pb-12 sm:pb-16">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <div className="mx-auto grid max-w-5xl grid-cols-1 gap-12 lg:gap-16 lg:grid-cols-2">
            {/* Form */}
            <AnimateOnScroll variant="slide-left">
            <Card className="shadow-sm">
              <CardHeader>
                <CardTitle>Send us a message</CardTitle>
                <CardDescription>
                  Fill out the form below and we'll get back to you within 24 hours.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {submitted ? (
                  <div className="py-8 text-center">
                    <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-success/10">
                      <Mail className="h-6 w-6 text-success" />
                    </div>
                    <h3 className="mt-4 text-lg font-semibold">Thank you!</h3>
                    <p className="mt-2 text-muted-foreground">
                      We've received your message and will be in touch soon.
                    </p>
                  </div>
                ) : (
                  <form onSubmit={handleSubmit} className="space-y-6" noValidate>
                    <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="firstName">
                          First name <span className="text-destructive">*</span>
                        </Label>
                        <Input
                          id="firstName"
                          name="firstName"
                          aria-required="true"
                          aria-invalid={!!errors.firstName}
                          aria-describedby={errors.firstName ? "firstName-error" : undefined}
                          className={errors.firstName ? "border-destructive" : ""}
                        />
                        {errors.firstName && (
                          <p id="firstName-error" className="text-sm text-destructive">
                            {errors.firstName}
                          </p>
                        )}
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="lastName">Last name</Label>
                        <Input id="lastName" name="lastName" />
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="email">
                        Email <span className="text-destructive">*</span>
                      </Label>
                      <Input
                        id="email"
                        name="email"
                        type="email"
                        aria-required="true"
                        aria-invalid={!!errors.email}
                        aria-describedby={errors.email ? "email-error" : undefined}
                        className={errors.email ? "border-destructive" : ""}
                      />
                      {errors.email && (
                        <p id="email-error" className="text-sm text-destructive">
                          {errors.email}
                        </p>
                      )}
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="company">Company</Label>
                      <Input id="company" name="company" />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="interest">I'm interested in</Label>
                      <Select name="interest">
                        <SelectTrigger>
                          <SelectValue placeholder="Select a product" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="mark8ly">Mark8ly</SelectItem>
                          <SelectItem value="homechef">HomeChef</SelectItem>
                          <SelectItem value="medicare">MediCare</SelectItem>
                          <SelectItem value="fanzone">FanZone</SelectItem>
                          <SelectItem value="other">Other / General inquiry</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="message">
                        Message <span className="text-destructive">*</span>
                      </Label>
                      <Textarea
                        id="message"
                        name="message"
                        rows={4}
                        placeholder="Tell us about your needs..."
                        aria-required="true"
                        aria-invalid={!!errors.message}
                        aria-describedby={errors.message ? "message-error" : undefined}
                        className={errors.message ? "border-destructive" : ""}
                      />
                      {errors.message && (
                        <p id="message-error" className="text-sm text-destructive">
                          {errors.message}
                        </p>
                      )}
                    </div>

                    <Button type="submit" className="w-full" disabled={isSubmitting}>
                      {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      {isSubmitting ? "Sending..." : "Send Message"}
                    </Button>
                  </form>
                )}
              </CardContent>
            </Card>
            </AnimateOnScroll>

            {/* Contact Info */}
            <AnimateOnScroll variant="slide-right">
            <div className="space-y-8">
              <div>
                <h2 className="text-2xl font-semibold text-foreground">Contact Information</h2>
                <p className="mt-4 text-muted-foreground leading-relaxed">
                  Reach out to us through any of these channels. We typically respond within one business day.
                </p>
              </div>

              <div className="space-y-6">
                {contactInfo.map((item) => (
                  <div key={item.title} className="flex items-start gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted shrink-0">
                      <item.icon className="h-5 w-5 text-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium text-foreground">{item.title}</h3>
                      {item.href ? (
                        <a
                          href={item.href}
                          className="text-muted-foreground hover:text-foreground transition-colors"
                        >
                          {item.description}
                        </a>
                      ) : (
                        <p className="text-muted-foreground">{item.description}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="rounded-lg bg-muted/50 p-6 border">
                <h3 className="font-semibold text-foreground">Schedule a Demo</h3>
                <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
                  Want to see our products in action? Book a personalized demo with our team.
                </p>
                <Button variant="outline" className="mt-4">
                  Book a Demo
                </Button>
              </div>
            </div>
            </AnimateOnScroll>
          </div>
        </div>
      </section>
    </div>
  );
}
