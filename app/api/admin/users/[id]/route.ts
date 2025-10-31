import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDatabase } from "@/lib/mongodb";

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const db = await getDatabase();
    const { id } = params;

    if (!ObjectId.isValid(id)) {
      return NextResponse.json(
        { success: false, error: "Invalid user ID" },
        { status: 400 }
      );
    }

    const userObjectId = new ObjectId(id);

    // Check if user exists
    const user = await db.collection("users").findOne({ _id: userObjectId });

    if (!user) {
      return NextResponse.json(
        { success: false, error: "User not found" },
        { status: 404 }
      );
    }

    // Prevent deletion of admin accounts (additional safety)
    if (user.role === "admin") {
      return NextResponse.json(
        { success: false, error: "Cannot delete admin accounts" },
        { status: 403 }
      );
    }

    // Use transaction for atomic operations
    const session = db.client.startSession();

    try {
      await session.withTransaction(async () => {
        // 1. Find all bookings for this user
        const bookings = await db
          .collection("bookings")
          .find({ userId: userObjectId })
          .toArray();

        const bookingIds = bookings.map((booking) => booking._id);

        // 2. Delete all payments for these bookings
        if (bookingIds.length > 0) {
          await db
            .collection("payments")
            .deleteMany({ bookingId: { $in: bookingIds } }, { session });
        }

        // 3. Update package available seats for confirmed bookings
        for (const booking of bookings) {
          if (
            booking.status === "confirmed" ||
            booking.paymentStatus === "paid"
          ) {
            await db.collection("packages").updateOne(
              { _id: booking.packageId },
              {
                $inc: { availableSeats: booking.numberOfTravelers },
                $set: { updatedAt: new Date() },
              },
              { session }
            );
          }
        }

        // 4. Delete all bookings for this user
        await db
          .collection("bookings")
          .deleteMany({ userId: userObjectId }, { session });

        // 5. Note: We don't delete reviews as per requirement
        // Reviews stay but are anonymized by keeping user reference

        // 6. Delete the user
        await db
          .collection("users")
          .deleteOne({ _id: userObjectId }, { session });
      });
    } finally {
      await session.endSession();
    }

    return NextResponse.json({
      success: true,
      message:
        "User and all related bookings/payments deleted successfully. Reviews were kept.",
    });
  } catch (error) {
    console.error("Error deleting user:", error);
    return NextResponse.json(
      { success: false, error: "Failed to delete user" },
      { status: 500 }
    );
  }
}
