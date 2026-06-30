import { Injectable } from "@angular/core";
import { loadStripe } from "@stripe/stripe-js";

export interface SeatPaymentOptions {
  clientSecret: string;
  publishableKey: string;
}

export type SeatPaymentResult =
  | { status: "succeeded" }
  | { status: "pending" }
  | { status: "cancelled" }
  | { status: "error"; message: string };

// Confirms the seat-increase proration PaymentIntent in-app. The server raised the Stripe quantity only to
// create the proration invoice (payment_behavior: default_incomplete); seat_limit is settled separately
// after this payment completes.
@Injectable({ providedIn: "root" })
export class SeatPaymentService {
  async open(options: SeatPaymentOptions): Promise<SeatPaymentResult> {
    const stripe = await loadStripe(options.publishableKey);
    if (!stripe) return { status: "error", message: "We couldn't load the secure payment check. Please try again." };

    // The proration invoice's PaymentIntent is created with the subscription's default payment method
    // attached but NOT yet confirmed, so it sits in `requires_confirmation` — there is no next action to
    // handle yet (handleNextAction throws "not in the requires_action state"). confirmPayment confirms it
    // against that method: a card runs its 3DS challenge in a modal and resolves inline (redirect:
    // "if_required" suppresses a redirect), while a redirect wallet (Revolut Pay, Amazon Pay) navigates to
    // return_url and completes asynchronously — handleSeatPaymentReturn settles it when the browser returns.
    const { error, paymentIntent } = await stripe.confirmPayment({
      clientSecret: options.clientSecret,
      confirmParams: { return_url: `${window.location.origin}/settings/account-plan?seat_payment=return` },
      redirect: "if_required",
    });
    if (error) {
      if (error.type === "validation_error") return { status: "cancelled" };
      return { status: "error", message: error.message ?? "Payment could not be completed." };
    }
    if (paymentIntent?.status === "succeeded") return { status: "succeeded" };
    return { status: "pending" };
  }
}
