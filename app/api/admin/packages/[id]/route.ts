import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDatabase } from "@/lib/mongodb";
import { uploadToCloudinary, deleteFromCloudinary } from "@/lib/cloudinary";
import type { TravelPackage, UpdatePackageDTO } from "@/lib/models/Package";

/**
 * GET /api/packages/[id]
 * Fetch a single package with destination details
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const db = await getDatabase();
    const { id } = params;

    if (!ObjectId.isValid(id)) {
      return NextResponse.json(
        { success: false, error: "Invalid package ID" },
        { status: 400 }
      );
    }

    const travelPackage = await db
      .collection<TravelPackage>("packages")
      .findOne({ _id: new ObjectId(id) });

    if (!travelPackage) {
      return NextResponse.json(
        { success: false, error: "Package not found" },
        { status: 404 }
      );
    }

    // Optionally fetch destination details
    const includeDestination =
      request.nextUrl.searchParams.get("includeDestination") === "true";
    let destination = null;

    if (includeDestination) {
      destination = await db
        .collection("destinations")
        .findOne({ _id: travelPackage.destinationId });
    }

    return NextResponse.json({
      success: true,
      package: travelPackage,
      destination: includeDestination ? destination : undefined,
    });
  } catch (error) {
    console.error("Error fetching package:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch package" },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/packages/[id]
 * Update a package with optional image replacement
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const db = await getDatabase();
    const { id } = params;

    if (!ObjectId.isValid(id)) {
      return NextResponse.json(
        { success: false, error: "Invalid package ID" },
        { status: 400 }
      );
    }

    // Get existing package
    const existingPackage = await db
      .collection<TravelPackage>("packages")
      .findOne({ _id: new ObjectId(id) });

    if (!existingPackage) {
      return NextResponse.json(
        { success: false, error: "Package not found" },
        { status: 404 }
      );
    }

    const contentType = request.headers.get("content-type");
    let updateData: UpdatePackageDTO;
    let newImageFile: File | null = null;

    // Handle multipart/form-data (with image)
    if (contentType?.includes("multipart/form-data")) {
      const formData = await request.formData();
      newImageFile = formData.get("image") as File | null;

      // Parse other fields
      updateData = {};
      for (const [key, value] of formData.entries()) {
        if (key !== "image") {
          try {
            // Try to parse JSON fields
            updateData[key as keyof UpdatePackageDTO] = JSON.parse(
              value as string
            );
          } catch {
            // If not JSON, use as is
            updateData[key as keyof UpdatePackageDTO] = value as any;
          }
        }
      }
    } else {
      // Handle JSON body
      updateData = await request.json();
    }

    // Build update document
    const updateDoc: any = {
      ...updateData,
      updatedAt: new Date(),
    };

    // Handle image replacement
    if (newImageFile && newImageFile.size > 0) {
      try {
        // Delete old image
        if (existingPackage.image?.publicId) {
          await deleteFromCloudinary(existingPackage.image.publicId);
        }

        // Upload new image
        const result = await uploadToCloudinary(
          newImageFile,
          process.env.CLOUDINARY_PACKAGE_FOLDER || "kuja-twende/packages"
        );

        updateDoc.image = {
          publicId: result.public_id,
          url: result.secure_url,
          width: result.width,
          height: result.height,
        };
      } catch (error) {
        console.error("Image upload failed:", error);
        return NextResponse.json(
          { success: false, error: "Failed to upload new image" },
          { status: 500 }
        );
      }
    }

    // Update slug if name changed
    if (updateData.name) {
      updateDoc.slug = updateData.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");
    }

    // Convert date strings to Date objects
    if (updateData.startDate)
      updateDoc.startDate = new Date(updateData.startDate);
    if (updateData.endDate) updateDoc.endDate = new Date(updateData.endDate);

    // Handle free package pricing
    if (updateData.isFree) {
      updateDoc.price = 0;
    }

    // Recalculate status based on dates and availability
    const now = new Date();
    const startDate = updateDoc.startDate
      ? new Date(updateDoc.startDate)
      : existingPackage.startDate;
    const endDate = updateDoc.endDate
      ? new Date(updateDoc.endDate)
      : existingPackage.endDate;
    const availableSeats =
      updateDoc.availableSeats !== undefined
        ? updateDoc.availableSeats
        : existingPackage.availableSeats;

    let status: "active" | "inactive" | "soldout" | "upcoming" = "upcoming";

    if (now >= startDate && now <= endDate) {
      status = availableSeats === 0 ? "soldout" : "active";
    } else if (now > endDate) {
      status = "inactive";
    } else {
      status = availableSeats === 0 ? "soldout" : "upcoming";
    }

    updateDoc.status = status;

    // Handle destination change
    if (
      updateData.destinationId &&
      updateData.destinationId !== existingPackage.destinationId.toString()
    ) {
      const newDestination = await db
        .collection("destinations")
        .findOne({ _id: new ObjectId(updateData.destinationId) });

      if (!newDestination) {
        return NextResponse.json(
          { success: false, error: "New destination not found" },
          { status: 404 }
        );
      }

      updateDoc.destinationId = new ObjectId(updateData.destinationId);
      updateDoc.destinationName = newDestination.name;

      // Update package counts
      await db
        .collection("destinations")
        .updateOne(
          { _id: existingPackage.destinationId },
          { $inc: { packagesCount: -1 } }
        );
      await db
        .collection("destinations")
        .updateOne(
          { _id: new ObjectId(updateData.destinationId) },
          { $inc: { packagesCount: 1 } }
        );
    }

    // Update availableSeats if totalSeats changed
    if (
      updateData.totalSeats &&
      updateData.totalSeats !== existingPackage.totalSeats
    ) {
      const difference = updateData.totalSeats - existingPackage.totalSeats;
      updateDoc.availableSeats = Math.max(
        0,
        existingPackage.availableSeats + difference
      );
    }

    // Update package
    const result = await db
      .collection("packages")
      .findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $set: updateDoc },
        { returnDocument: "after" }
      );

    return NextResponse.json({
      success: true,
      package: result,
      message: "Package updated successfully",
    });
  } catch (error) {
    console.error("Error updating package:", error);
    return NextResponse.json(
      { success: false, error: "Failed to update package" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/packages/[id]
 * Delete a package and cleanup all related data
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const db = await getDatabase();
    const { id } = params;

    if (!ObjectId.isValid(id)) {
      return NextResponse.json(
        { success: false, error: "Invalid package ID" },
        { status: 400 }
      );
    }

    const packageObjectId = new ObjectId(id);

    // Check if package exists
    const travelPackage = await db
      .collection<TravelPackage>("packages")
      .findOne({ _id: packageObjectId });

    if (!travelPackage) {
      return NextResponse.json(
        { success: false, error: "Package not found" },
        { status: 404 }
      );
    }

    // Delete all related data in transaction
    const session = db.client.startSession();

    try {
      await session.withTransaction(async () => {
        // 1. Delete package image from Cloudinary
        if (travelPackage.image?.publicId) {
          await deleteFromCloudinary(travelPackage.image.publicId).catch(
            (err) =>
              console.error("Failed to delete image from Cloudinary:", err)
          );
        }

        // 2. Find all bookings for this package
        const bookings = await db
          .collection("bookings")
          .find({ packageId: packageObjectId })
          .toArray();

        const bookingIds = bookings.map((booking) => booking._id);

        // 3. Delete all payments for these bookings
        if (bookingIds.length > 0) {
          await db
            .collection("payments")
            .deleteMany({ bookingId: { $in: bookingIds } }, { session });
        }

        // 4. Delete all bookings for this package
        await db
          .collection("bookings")
          .deleteMany({ packageId: packageObjectId }, { session });

        // 5. Delete all package reviews
        await db
          .collection("package_reviews")
          .deleteMany({ packageId: packageObjectId }, { session });

        // 6. Delete the package itself
        await db
          .collection("packages")
          .deleteOne({ _id: packageObjectId }, { session });

        // 7. Decrement destination package count
        await db.collection("destinations").updateOne(
          { _id: travelPackage.destinationId },
          {
            $inc: { packagesCount: -1 },
            $set: { updatedAt: new Date() },
          },
          { session }
        );
      });
    } finally {
      await session.endSession();
    }

    return NextResponse.json({
      success: true,
      message: "Package and all related data deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting package:", error);
    return NextResponse.json(
      { success: false, error: "Failed to delete package" },
      { status: 500 }
    );
  }
}
